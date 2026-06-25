import { ForbiddenException, Injectable } from '@nestjs/common';
import { FastifyRequest } from 'fastify';
import { isIP } from 'node:net';
import { EnvironmentService } from '../../integrations/environment/environment.service';
import { Attachment, Page } from '@docmost/db/types/entity.types';

export type NetworkOriginScope = 'internal' | 'external' | 'unknown';

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

@Injectable()
export class NetworkOriginService {
  constructor(private readonly environmentService: EnvironmentService) {}

  getRequestOrigin(
    req: FastifyRequest | { ip?: string; headers?: any },
  ): NetworkOrigin {
    const ip = this.resolveClientIp(req);
    if (!ip) {
      return this.unknownOrigin();
    }

    const network = this.toOriginNetwork(ip);
    if (!network) {
      return this.unknownOrigin();
    }

    return {
      originIp: ip,
      originNetwork: network,
      originNetworkScope: this.isInternalIp(ip) ? 'internal' : 'external',
      originRecordedAt: new Date(),
    };
  }

  assertCanExportPage(
    page: Pick<Page, 'originNetwork'>,
    req: FastifyRequest,
  ): void {
    this.assertAllowed(page.originNetwork, req);
  }

  assertCanPrintPage(
    page: Pick<Page, 'originNetwork'>,
    req: FastifyRequest,
  ): void {
    this.assertAllowed(page.originNetwork, req);
  }

  assertCanDownloadAttachment(
    attachment: Pick<Attachment, 'originNetwork'>,
    req: FastifyRequest,
  ): void {
    this.assertAllowed(attachment.originNetwork, req);
  }

  filterAllowedPages<T extends Pick<Page, 'originNetwork'>>(
    pages: T[],
    req: FastifyRequest,
  ): T[] {
    return pages.filter((page) => this.isAllowed(page.originNetwork, req));
  }

  filterAllowedAttachments<T extends Pick<Attachment, 'originNetwork'>>(
    attachments: T[],
    req: FastifyRequest,
  ): T[] {
    return attachments.filter((attachment) =>
      this.isAllowed(attachment.originNetwork, req),
    );
  }

  isAllowed(
    resourceOriginNetwork: string | null | undefined,
    req: FastifyRequest,
  ): boolean {
    const requestOrigin = this.getRequestOrigin(req);
    if (requestOrigin.originNetworkScope === 'internal') {
      return true;
    }

    if (!resourceOriginNetwork) {
      return this.environmentService.getUnknownOriginPolicy() === 'allow';
    }

    return requestOrigin.originNetwork === resourceOriginNetwork;
  }

  private assertAllowed(
    resourceOriginNetwork: string | null | undefined,
    req: FastifyRequest,
  ): void {
    if (!this.isAllowed(resourceOriginNetwork, req)) {
      throw new ForbiddenException('Network origin does not allow this action');
    }
  }

  private unknownOrigin(): NetworkOrigin {
    return {
      originIp: null,
      originNetwork: null,
      originNetworkScope: 'unknown',
      originRecordedAt: null,
    };
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
