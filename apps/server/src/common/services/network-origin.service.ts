import { ForbiddenException, Injectable, Logger } from '@nestjs/common';
import { FastifyRequest } from 'fastify';
import { isIP } from 'node:net';
import { EnvironmentService } from '../../integrations/environment/environment.service';
import { Attachment, Page } from '@docmost/db/types/entity.types';

export type NetworkOriginScope = 'internal' | 'external' | 'mrdoc' | 'unknown';

export type RequestZone = 'internal' | 'office' | 'unknown';

const ENTRANCE_HEADER = 'x-docmost-entrance';

// Higher = more trusted / grants more. Used to pick the "stricter" (lower)
// zone when the Caddy entrance header and the client-IP CIDR disagree.
const ZONE_RANK: Record<RequestZone, number> = {
  internal: 2,
  office: 1,
  unknown: 0,
};

export type NetworkOrigin = {
  originIp: string | null;
  originNetwork: string | null;
  originNetworkScope: NetworkOriginScope;
  originRecordedAt: Date | null;
};

type ParsedCidr = {
  ip: bigint;
  prefix: number;
  bits: number;
};

/**
 * Async import (zip/bulk-files) creates pages/attachments from a background
 * job with no request context, so the origin captured at upload time is
 * snapshotted into `file_tasks.metadata` and read back by the processor
 * (design v2 §5 "Page import", P3.6). These two helpers are the only place
 * that (de)serializes that snapshot shape.
 */
export function originToFileTaskMetadata(
  origin: NetworkOrigin | null | undefined,
): Record<string, string | null> | null {
  if (!origin) return null;
  return {
    originIp: origin.originIp,
    originNetwork: origin.originNetwork,
    originNetworkScope: origin.originNetworkScope,
    originRecordedAt: origin.originRecordedAt?.toISOString() ?? null,
  };
}

export function originFromFileTaskMetadata(
  metadata: unknown,
): Pick<
  NetworkOrigin,
  'originIp' | 'originNetwork' | 'originNetworkScope' | 'originRecordedAt'
> | null {
  if (!metadata || typeof metadata !== 'object') return null;
  const o = metadata as Record<string, unknown>;
  if (typeof o.originNetworkScope !== 'string' && o.originIp == null) {
    return null;
  }
  return {
    originIp: typeof o.originIp === 'string' ? o.originIp : null,
    originNetwork: typeof o.originNetwork === 'string' ? o.originNetwork : null,
    originNetworkScope:
      typeof o.originNetworkScope === 'string'
        ? (o.originNetworkScope as NetworkOriginScope)
        : null,
    originRecordedAt:
      typeof o.originRecordedAt === 'string'
        ? new Date(o.originRecordedAt)
        : null,
  };
}

@Injectable()
export class NetworkOriginService {
  private readonly logger = new Logger(NetworkOriginService.name);

  constructor(private readonly environmentService: EnvironmentService) {}

  getRequestOrigin(
    req: FastifyRequest | { ip?: string; headers?: any },
  ): NetworkOrigin {
    const ip = this.resolveClientIp(req);
    const zone = this.getCurrentUserNetworkZone(req);

    return {
      // ip/network are recorded for audit even when the zone comes from the
      // static deployment override below — they just don't drive the decision.
      originIp: ip,
      originNetwork: ip ? this.toOriginNetwork(ip) : null,
      originNetworkScope: this.zoneToScope(zone),
      originRecordedAt: new Date(),
    };
  }

  /**
   * Zone resolution precedence:
   *
   * 1. **Session-stamped zone** — decided once, at login time: native Docmost
   *    login uses `EnvironmentService.getNativeLoginZone()` (internal by
   *    business rule); WUJI SSO uses the
   *    zone derived by wuji-adapter from its `WUJI_HOST` IP/CIDRs (or explicit
   *    `WUJI_ZONE`). `JwtStrategy.validate` reads it back per request and
   *    attaches it as `req.raw.sessionZone`. This is authoritative for any
   *    authenticated request — it does not re-derive from the current request's
   *    IP, so a session started on one network still works correctly if the
   *    user's IP momentarily looks ambiguous (VPN, proxy).
   * 2. `DOCMOST_DEPLOYMENT_ZONE` static override — fallback for requests with
   *    no session to read (public share links, API keys) on a topology where
   *    the *entire deployment* sits permanently in one network.
   * 3. Hybrid header+CIDR resolution (`resolveZone`, below) — fallback for a
   *    *single shared* deployment serving both networks with no session
   *    context, classifying by Caddy's dual entrances +
   *    `DOCMOST_INTERNAL_CIDRS`/`DOCMOST_OFFICE_CIDRS` (Phase 8 / G1).
   */
  getCurrentUserNetworkZone(
    req: FastifyRequest | { ip?: string; headers?: any; raw?: { sessionZone?: string } },
  ): RequestZone {
    const sessionZone = (req as any)?.raw?.sessionZone;
    if (sessionZone === 'internal' || sessionZone === 'office') {
      return sessionZone;
    }

    const deploymentZone = this.environmentService.getDeploymentZone();
    if (deploymentZone) {
      return deploymentZone;
    }

    const ip = this.resolveClientIp(req);
    if (!ip) return 'unknown';
    return this.resolveZone(ip, req.headers);
  }

  /**
   * Backward-compatible name for older call sites. New code should call
   * `getCurrentUserNetworkZone()` so the business meaning is explicit:
   * "which network zone is the current authenticated user/request in?"
   */
  getRequestZone(
    req: FastifyRequest | { ip?: string; headers?: any; raw?: { sessionZone?: string } },
  ): RequestZone {
    return this.getCurrentUserNetworkZone(req);
  }

  isCurrentUserInternal(
    req: FastifyRequest | { ip?: string; headers?: any; raw?: { sessionZone?: string } },
  ): boolean {
    return this.getCurrentUserNetworkZone(req) === 'internal';
  }

  isCurrentUserOffice(
    req: FastifyRequest | { ip?: string; headers?: any; raw?: { sessionZone?: string } },
  ): boolean {
    return this.getCurrentUserNetworkZone(req) === 'office';
  }

  /**
   * Hybrid zone resolution (design v2 §3 "混合入口判別", Phase 8 / G1) — only
   * used when `DOCMOST_DEPLOYMENT_ZONE` is unset (see `getRequestZone`). The
   * dual Caddy entrances stamp a trusted `X-Docmost-Entrance: internal|office`
   * header and strip any client-supplied one before proxying to Docmost. We
   * cross-check that header against the CIDR-derived zone and take the
   * stricter (lower-privilege) of the two on disagreement — so a caller
   * cannot use the header to *escalate* past what their IP allows, only to
   * (harmlessly) downgrade themselves. Deployments with a single entrance
   * never send the header, so this falls back to pure-CIDR automatically;
   * `DOCMOST_ENTRANCE_HEADER_REQUIRED=true` treats an absent header as
   * suspicious (e.g. Docmost reached directly, bypassing Caddy) rather than
   * silently trusting the CIDR-only result.
   */
  private resolveZone(ip: string, headers?: Record<string, unknown>): RequestZone {
    const cidrZone: RequestZone = this.isInternalIp(ip)
      ? 'internal'
      : this.isOfficeIp(ip)
        ? 'office'
        : 'unknown';

    const headerZone = this.resolveHeaderZone(headers);

    if (!headerZone) {
      if (this.environmentService.getEntranceHeaderRequired()) {
        this.logger.warn(
          `Missing required ${ENTRANCE_HEADER} header for ip=${ip}; treating as unknown zone`,
        );
        return 'unknown';
      }
      return cidrZone;
    }

    if (headerZone !== cidrZone) {
      this.logger.warn(
        `Entrance header/CIDR zone mismatch for ip=${ip}: header=${headerZone} cidr=${cidrZone}; using the stricter zone`,
      );
    }

    return ZONE_RANK[headerZone] <= ZONE_RANK[cidrZone] ? headerZone : cidrZone;
  }

  private resolveHeaderZone(
    headers?: Record<string, unknown>,
  ): RequestZone | null {
    const raw = headers?.[ENTRANCE_HEADER];
    const value = typeof raw === 'string' ? raw : Array.isArray(raw) ? raw[0] : null;
    return value === 'internal' || value === 'office' ? value : null;
  }

  private zoneToScope(zone: RequestZone): NetworkOriginScope {
    if (zone === 'internal') return 'internal';
    if (zone === 'office') return 'external';
    return 'unknown';
  }

  assertCanExportPage(
    page: Pick<Page, 'id' | 'originNetworkScope'>,
    req: FastifyRequest,
  ): void {
    this.assertAllowed(page.originNetworkScope, req, {
      action: 'export',
      resourceType: 'page',
      resourceId: page.id,
    });
  }

  assertCanPrintPage(
    page: Pick<Page, 'id' | 'originNetworkScope'>,
    req: FastifyRequest,
  ): void {
    this.assertAllowed(page.originNetworkScope, req, {
      action: 'print',
      resourceType: 'page',
      resourceId: page.id,
    });
  }

  assertCanDownloadAttachment(
    attachment: Pick<Attachment, 'id' | 'originNetworkScope'>,
    req: FastifyRequest,
  ): void {
    this.assertAllowed(attachment.originNetworkScope, req, {
      action: 'download',
      resourceType: 'attachment',
      resourceId: attachment.id,
    });
  }

  filterAllowedPages<T extends Pick<Page, 'id' | 'originNetworkScope'>>(
    pages: T[],
    req: FastifyRequest,
    action: 'export' = 'export',
  ): T[] {
    const blocked: string[] = [];
    const allowed = pages.filter((page) => {
      const ok = this.isAllowed(page.originNetworkScope, req);
      if (!ok) blocked.push(page.id);
      return ok;
    });
    if (blocked.length > 0) {
      this.logBlocked(req, {
        action,
        resourceType: 'page',
        resourceIds: blocked,
      });
    }
    return allowed;
  }

  filterAllowedAttachments<
    T extends Pick<Attachment, 'id' | 'originNetworkScope'>,
  >(attachments: T[], req: FastifyRequest, action: 'export' = 'export'): T[] {
    const blocked: string[] = [];
    const allowed = attachments.filter((attachment) => {
      const ok = this.isAllowed(attachment.originNetworkScope, req);
      if (!ok) blocked.push(attachment.id);
      return ok;
    });
    if (blocked.length > 0) {
      this.logBlocked(req, {
        action,
        resourceType: 'attachment',
        resourceIds: blocked,
      });
    }
    return allowed;
  }

  /**
   * Zone-based policy (2026-07-03 design v2): a resource's origin_network_scope
   * decides who may export/download it, not whether requester and uploader
   * share a subnet. `origin_network` is retained on the resource purely for
   * audit purposes and no longer participates in this decision.
   */
  isAllowed(
    resourceOriginScope: NetworkOriginScope | string | null | undefined,
    req: FastifyRequest,
  ): boolean {
    const requestZone = this.getCurrentUserNetworkZone(req);

    if (requestZone === 'internal') {
      return true;
    }

    if (requestZone === 'unknown') {
      return false;
    }

    // requestZone === 'office' from here on
    switch (resourceOriginScope) {
      case 'internal':
      case 'mrdoc':
        return false;
      case 'external':
        return true;
      default:
        return this.environmentService.getUnknownOriginPolicy() === 'allow';
    }
  }

  private assertAllowed(
    resourceOriginScope: NetworkOriginScope | string | null | undefined,
    req: FastifyRequest,
    context: { action: string; resourceType: string; resourceId?: string },
  ): void {
    if (!this.isAllowed(resourceOriginScope, req)) {
      this.logBlocked(req, {
        action: context.action,
        resourceType: context.resourceType,
        resourceIds: context.resourceId ? [context.resourceId] : [],
        resourceOriginScope,
      });
      throw new ForbiddenException('Network origin does not allow this action');
    }
  }

  /**
   * Design v2 §7 "Audit / 診斷": until a formal audit event exists for
   * network-origin denials, blocked actions get a structured warn log tagged
   * NETWORK_ORIGIN_PERMISSION_BLOCKED so they're at least greppable/alertable.
   */
  private logBlocked(
    req: FastifyRequest,
    details: {
      action: string;
      resourceType: string;
      resourceIds: string[];
      resourceOriginScope?: NetworkOriginScope | string | null;
    },
  ): void {
    const requestZone = this.getCurrentUserNetworkZone(req);
    const ip = this.resolveClientIp(req);
    this.logger.warn(
      `NETWORK_ORIGIN_PERMISSION_BLOCKED action=${details.action} resourceType=${details.resourceType} ` +
        `resourceId=${details.resourceIds.join(',') || 'n/a'} requestZone=${requestZone} ` +
        `resourceOriginScope=${details.resourceOriginScope ?? 'n/a'} ip=${ip ?? 'unknown'}`,
    );
  }

  private resolveClientIp(
    req: FastifyRequest | { ip?: string; headers?: any },
  ): string | null {
    const directIp = this.normalizeIp(req.ip);
    if (!this.environmentService.getTrustProxy()) {
      return directIp;
    }

    const forwardedFor = req.headers?.['x-forwarded-for'];
    const forwardedIp =
      typeof forwardedFor === 'string'
        ? forwardedFor.split(',')[0]?.trim()
        : Array.isArray(forwardedFor)
          ? forwardedFor[0]?.split(',')[0]?.trim()
          : null;

    return (
      this.normalizeIp(forwardedIp) ||
      this.normalizeIp(req.headers?.['x-real-ip']) ||
      directIp
    );
  }

  private normalizeIp(value: unknown): string | null {
    if (typeof value !== 'string') return null;
    let ip = value.trim();
    if (!ip) return null;

    if (ip.startsWith('::ffff:')) {
      ip = ip.slice('::ffff:'.length);
    }

    if (ip.startsWith('[') && ip.includes(']')) {
      ip = ip.slice(1, ip.indexOf(']'));
    } else if (
      ip.includes(':') &&
      ip.includes('.') &&
      ip.lastIndexOf(':') > ip.lastIndexOf('.')
    ) {
      ip = ip.slice(0, ip.lastIndexOf(':'));
    }

    return isIP(ip) ? ip : null;
  }

  private isInternalIp(ip: string): boolean {
    return this.environmentService
      .getInternalCidrs()
      .some((cidr) => this.ipInCidr(ip, cidr));
  }

  private isOfficeIp(ip: string): boolean {
    return this.environmentService
      .getOfficeCidrs()
      .some((cidr) => this.ipInCidr(ip, cidr));
  }

  private toOriginNetwork(ip: string): string | null {
    const version = isIP(ip);
    if (version === 4) {
      const prefix = this.environmentService.getOriginNetworkMaskV4();
      return this.maskIp(ip, prefix, 32);
    }
    if (version === 6) {
      const prefix = this.environmentService.getOriginNetworkMaskV6();
      return this.maskIp(ip, prefix, 128);
    }
    return null;
  }

  private ipInCidr(ip: string, cidr: string): boolean {
    const parsedIp = this.parseIp(ip);
    const parsedCidr = this.parseCidr(cidr);
    if (!parsedIp || !parsedCidr || parsedIp.bits !== parsedCidr.bits) {
      return false;
    }
    const mask = this.maskFor(parsedCidr.prefix, parsedCidr.bits);
    return (parsedIp.ip & mask) === (parsedCidr.ip & mask);
  }

  private maskIp(ip: string, prefix: number, bits: number): string | null {
    const parsedIp = this.parseIp(ip);
    if (!parsedIp || parsedIp.bits !== bits) return null;
    const mask = this.maskFor(prefix, bits);
    return `${this.formatIp(parsedIp.ip & mask, bits)}/${prefix}`;
  }

  private parseCidr(cidr: string): ParsedCidr | null {
    const [ip, prefixRaw] = cidr.split('/');
    const parsedIp = this.parseIp(ip);
    const prefix = Number.parseInt(prefixRaw, 10);
    if (
      !parsedIp ||
      !Number.isInteger(prefix) ||
      prefix < 0 ||
      prefix > parsedIp.bits
    ) {
      return null;
    }

    return { ...parsedIp, prefix };
  }

  private parseIp(ip: string): { ip: bigint; bits: number } | null {
    const version = isIP(ip);
    if (version === 4) {
      const parts = ip.split('.').map((part) => Number.parseInt(part, 10));
      if (parts.length !== 4 || parts.some((part) => part < 0 || part > 255)) {
        return null;
      }
      return {
        ip: parts.reduce((acc, part) => (acc << 8n) + BigInt(part), 0n),
        bits: 32,
      };
    }

    if (version === 6) {
      return this.parseIpv6(ip);
    }

    return null;
  }

  private parseIpv6(ip: string): { ip: bigint; bits: number } | null {
    const [headRaw, tailRaw] = ip.split('::');
    if (ip.split('::').length > 2) return null;

    const parsePart = (part: string): number[] => {
      if (!part) return [];
      return part.split(':').flatMap((segment) => {
        if (segment.includes('.')) {
          const parsed = this.parseIp(segment);
          if (!parsed || parsed.bits !== 32) return [];
          return [
            Number((parsed.ip >> 16n) & 0xffffn),
            Number(parsed.ip & 0xffffn),
          ];
        }
        const value = Number.parseInt(segment, 16);
        return Number.isInteger(value) && value >= 0 && value <= 0xffff
          ? [value]
          : [];
      });
    };

    const head = parsePart(headRaw);
    const tail = tailRaw === undefined ? [] : parsePart(tailRaw);
    const missing = tailRaw === undefined ? 0 : 8 - head.length - tail.length;
    const groups = [...head, ...Array(Math.max(missing, 0)).fill(0), ...tail];

    if (groups.length !== 8) return null;
    return {
      ip: groups.reduce((acc, group) => (acc << 16n) + BigInt(group), 0n),
      bits: 128,
    };
  }

  private maskFor(prefix: number, bits: number): bigint {
    if (prefix <= 0) return 0n;
    return ((1n << BigInt(prefix)) - 1n) << BigInt(bits - prefix);
  }

  private formatIp(ip: bigint, bits: number): string {
    if (bits === 32) {
      return [24n, 16n, 8n, 0n]
        .map((shift) => Number((ip >> shift) & 0xffn))
        .join('.');
    }

    const groups: string[] = [];
    for (let shift = 112; shift >= 0; shift -= 16) {
      groups.push(Number((ip >> BigInt(shift)) & 0xffffn).toString(16));
    }
    return groups.join(':');
  }
}
