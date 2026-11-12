import { CanActivate, ExecutionContext, ForbiddenException, Injectable } from '@nestjs/common';

/**
 * Rejects requests authenticated with an API key. Must run after JwtAuthGuard,
 * which marks API-key requests with `req.raw.authType = 'api_key'`.
 *
 * Used on key management: a key that can mint keys outlives its own revocation
 * (revoking the leaked key leaves every key it created working), and a key that
 * can list keys exposes every other key's owner and usage.
 */
@Injectable()
export class RejectApiKeyAuthGuard implements CanActivate {
  canActivate(context: ExecutionContext): boolean {
    const req = context.switchToHttp().getRequest();
    if (req?.raw?.authType === 'api_key') {
      throw new ForbiddenException('API keys cannot manage API keys; sign in to the web UI instead');
    }
    return true;
  }
}
