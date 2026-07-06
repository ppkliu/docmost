import { Injectable, Logger, UnauthorizedException } from '@nestjs/common';
import { PassportStrategy } from '@nestjs/passport';
import { Strategy } from 'passport-jwt';
import { EnvironmentService } from '../../../integrations/environment/environment.service';
import { JwtApiKeyPayload, JwtPayload, JwtType } from '../dto/jwt-payload';
import { WorkspaceRepo } from '@docmost/db/repos/workspace/workspace.repo';
import { UserRepo } from '@docmost/db/repos/user/user.repo';
import { UserSessionRepo } from '@docmost/db/repos/session/user-session.repo';
import { SessionActivityService } from '../../session/session-activity.service';
import { FastifyRequest } from 'fastify';
import { extractBearerTokenFromHeader, isUserDisabled } from '../../../common/helpers';
import { UserRole } from '../../../common/helpers/types/permission';
import { ModuleRef } from '@nestjs/core';
import { ApiKeyService } from '../../api-key/api-key.service';

/**
 * H1 attribution: a service API key owned by a workspace admin/owner may act
 * on behalf of a member, so agent-submitted content (e.g. Hermes knowledge
 * precipitation) is attributed to the real author instead of the service
 * account. Member-owned keys cannot impersonate.
 */
export const ON_BEHALF_OF_HEADER = 'x-on-behalf-of';

@Injectable()
export class JwtStrategy extends PassportStrategy(Strategy, 'jwt') {
  private logger = new Logger('JwtStrategy');

  constructor(
    private userRepo: UserRepo,
    private workspaceRepo: WorkspaceRepo,
    private userSessionRepo: UserSessionRepo,
    private sessionActivityService: SessionActivityService,
    private readonly environmentService: EnvironmentService,
    private moduleRef: ModuleRef,
  ) {
    super({
      jwtFromRequest: (req: FastifyRequest) => {
        return req.cookies?.authToken || extractBearerTokenFromHeader(req);
      },
      ignoreExpiration: false,
      secretOrKey: environmentService.getAppSecret(),
      passReqToCallback: true,
    });
  }

  async validate(req: any, payload: JwtPayload | JwtApiKeyPayload) {
    if (!payload.workspaceId) {
      throw new UnauthorizedException();
    }

    if (req.raw.workspaceId && req.raw.workspaceId !== payload.workspaceId) {
      throw new UnauthorizedException('Workspace does not match');
    }

    if (payload.type === JwtType.API_KEY) {
      return this.validateApiKey(req, payload as JwtApiKeyPayload);
    }

    if (payload.type !== JwtType.ACCESS) {
      throw new UnauthorizedException();
    }

    const workspace = await this.workspaceRepo.findById(payload.workspaceId);

    if (!workspace) {
      throw new UnauthorizedException();
    }
    const user = await this.userRepo.findById(payload.sub, payload.workspaceId);

    if (!user || isUserDisabled(user)) {
      throw new UnauthorizedException();
    }

    if ((payload as JwtPayload).sessionId) {
      const sessionId = (payload as JwtPayload).sessionId;
      const session = await this.userSessionRepo.findActiveById(sessionId);
      if (!session || session.userId !== payload.sub || session.workspaceId !== payload.workspaceId) {
        throw new UnauthorizedException();
      }
      req.raw.sessionId = sessionId;
      // Network-origin permissions: the zone is decided once at login time
      // (native login => office; WUJI SSO via the adapter's WUJI_HOST/IP
      // zone), then stamped onto the session. Reading
      // it back here means NetworkOriginService never has to guess from the
      // current request's IP for any authenticated request.
      const sessionMetadata = session.metadata as { zone?: string } | null;
      if (sessionMetadata?.zone === 'internal' || sessionMetadata?.zone === 'office') {
        req.raw.sessionZone = sessionMetadata.zone;
      }
      this.sessionActivityService.trackActivity(sessionId, payload.sub, payload.workspaceId);
    }

    return { user, workspace };
  }

  private async validateApiKey(req: any, payload: JwtApiKeyPayload) {
    // Prefer the enterprise API key service when bundled, otherwise fall back
    // to the open-source implementation (core ApiKeyModule).
    try {
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const EeApiKeyModule = require('./../../../ee/api-key/api-key.service');
      if (EeApiKeyModule?.ApiKeyService) {
        const eeService = this.moduleRef.get(EeApiKeyModule.ApiKeyService, {
          strict: false,
        });
        const eeResult = await eeService.validateApiKey(payload);
        return this.applyOnBehalfOf(req, eeResult);
      }
    } catch (err) {
      this.logger.debug(
        'Enterprise API Key module not bundled; using open-source API key service',
      );
    }

    const apiKeyService = this.moduleRef.get(ApiKeyService, { strict: false });
    if (!apiKeyService) {
      throw new UnauthorizedException('API Key module missing');
    }
    const result = await apiKeyService.validateApiKey(payload);
    return this.applyOnBehalfOf(req, result);
  }

  /**
   * Swaps the request identity to the on-behalf-of user when the key owner is
   * allowed to delegate. Invalid targets fail loudly (401) rather than
   * silently mis-attributing content to the service account.
   */
  private async applyOnBehalfOf(
    req: any,
    result: { user: any; workspace: any },
  ) {
    const email = String(
      req?.raw?.headers?.[ON_BEHALF_OF_HEADER] ?? '',
    ).trim();
    if (!email) {
      return result;
    }

    const owner = result.user;
    if (owner.role !== UserRole.ADMIN && owner.role !== UserRole.OWNER) {
      throw new UnauthorizedException(
        'This API key cannot act on behalf of other users',
      );
    }

    const target = await this.userRepo.findByEmail(
      email.toLowerCase(),
      result.workspace.id,
    );
    if (!target || isUserDisabled(target)) {
      throw new UnauthorizedException(
        `Unknown on-behalf-of user: ${email}`,
      );
    }

    // surfaced for audit logging downstream
    req.raw.impersonatorId = owner.id;
    this.logger.log(
      `API key of ${owner.id} acting on behalf of ${target.id} (${email})`,
    );
    return { user: target, workspace: result.workspace };
  }
}
