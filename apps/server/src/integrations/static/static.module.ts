import { Module, OnModuleInit } from '@nestjs/common';
import { HttpAdapterHost } from '@nestjs/core';
import { join } from 'path';
import * as fs from 'node:fs';
import fastifyStatic from '@fastify/static';
import { EnvironmentService } from '../environment/environment.service';
import { htmlEscape } from '../../common/helpers/html-escaper';

function normalizePublicPathPrefix(value?: string): string {
  const raw = (value || '').trim();
  if (!raw || raw === '/') return '';
  return `/${raw.replace(/^\/+|\/+$/g, '')}`;
}

function prefixIndexAssetUrls(html: string, publicPathPrefix: string): string {
  if (!publicPathPrefix) return html;
  return html.replace(
    /\b(src|href)="\/((?:assets|icons)\/[^"]+|manifest\.json)"/g,
    (_match, attr, path) => `${attr}="${publicPathPrefix}/${path}"`,
  );
}

export function applyAppNameToIndexHtml(
  html: string,
  appName?: string,
): string {
  const normalizedAppName = appName?.trim();
  if (!normalizedAppName) return html;

  const escapedAppName = htmlEscape(normalizedAppName);

  return html
    .replace(/<title>[\s\S]*?<\/title>/i, `<title>${escapedAppName}</title>`)
    .replace(
      /(<meta\s+name="apple-mobile-web-app-title"\s+content=")[^"]*("\s*\/?>)/i,
      `$1${escapedAppName}$2`,
    );
}

/**
 * The placeholder the KB widget script is injected at. Lives in the client's
 * index.html next to <!--window-config-->, and is substituted the same way.
 */
export const KB_WIDGET_MARKER = '<!--kb-widget-->';

/**
 * Injects the knowledge-base widget script tag, or removes the placeholder when
 * no widget is configured.
 *
 * ★ Why here rather than in a reverse proxy: rewriting `</body>` at the proxy
 *   works until Docmost's HTML changes shape, and then it **fails silently** —
 *   the badge just stops appearing and nobody files a bug. Substituting a
 *   placeholder we put there ourselves cannot drift, and it needs no custom
 *   proxy build (the `replace-response` Caddy plugin is not in the official
 *   image).
 *
 * ★ Unset KB_WIDGET_URL means "no widget": the marker is dropped and the page
 *   is byte-for-byte what it was before this feature existed.
 */
export function applyKbWidgetToIndexHtml(html: string, widgetUrl?: string): string {
  const url = widgetUrl?.trim();
  if (!url) return html.replace(KB_WIDGET_MARKER, '');
  // The URL comes from server env, not user input, but it lands in an HTML
  // attribute — escape it anyway rather than relying on that staying true.
  return html.replace(
    KB_WIDGET_MARKER,
    `<script src="${htmlEscape(url)}" defer></script>`,
  );
}

export function readFreshIndexTemplate(
  indexFilePath: string,
  indexTemplateFilePath: string,
  marker: string,
): string {
  const currentIndex = fs.readFileSync(indexFilePath, 'utf8');

  // A fresh Vite build contains the injection marker. Refresh a template left
  // behind by an overlay deployment so it cannot reference obsolete hashes.
  if (currentIndex.includes(marker)) {
    fs.copyFileSync(indexFilePath, indexTemplateFilePath);
    return currentIndex;
  }

  if (fs.existsSync(indexTemplateFilePath)) {
    return fs.readFileSync(indexTemplateFilePath, 'utf8');
  }

  return currentIndex;
}

@Module({})
export class StaticModule implements OnModuleInit {
  constructor(
    private readonly httpAdapterHost: HttpAdapterHost,
    private readonly environmentService: EnvironmentService,
  ) {}

  public async onModuleInit() {
    const httpAdapter = this.httpAdapterHost.httpAdapter;
    const app = httpAdapter.getInstance();

    const clientDistPath = join(
      __dirname,
      '..',
      '..',
      '..',
      '..',
      'client/dist',
    );

    const indexFilePath = join(clientDistPath, 'index.html');

    if (fs.existsSync(clientDistPath) && fs.existsSync(indexFilePath)) {
      const indexTemplateFilePath = join(clientDistPath, 'index-template.html');
      const windowVar = '<!--window-config-->';

      const publicPathPrefix = normalizePublicPathPrefix(
        process.env.DOCMOST_PUBLIC_PATH_PREFIX,
      );

      const configString = {
        ENV: this.environmentService.getNodeEnv(),
        APP_URL: this.environmentService.getAppUrl(),
        DOCMOST_PUBLIC_PATH_PREFIX: publicPathPrefix || undefined,
        APP_NAME: process.env.APP_NAME || undefined,
        CLOUD: this.environmentService.isCloud(),
        FILE_UPLOAD_SIZE_LIMIT:
          this.environmentService.getFileUploadSizeLimit(),
        FILE_IMPORT_SIZE_LIMIT:
          this.environmentService.getFileImportSizeLimit(),
        DRAWIO_URL: this.environmentService.getDrawioUrl(),
        SUBDOMAIN_HOST: this.environmentService.isCloud()
          ? this.environmentService.getSubdomainHost()
          : undefined,
        COLLAB_URL: this.environmentService.getCollabUrl(),
        BILLING_TRIAL_DAYS: this.environmentService.isCloud()
          ? this.environmentService.getBillingTrialDays()
          : undefined,
        POSTHOG_HOST: this.environmentService.getPostHogHost(),
        POSTHOG_KEY: this.environmentService.getPostHogKey(),
        EDITOR_TOOLBAR_DEFAULT:
          this.environmentService.getEditorToolbarDefault(),
        SPACE_MEMBER_CREATE_ENABLED:
          this.environmentService.getSpaceMemberCreateEnabled(),
      };

      const windowScriptContent = `<script>window.CONFIG=${JSON.stringify(configString)};</script>`;

      const html = readFreshIndexTemplate(
        indexFilePath,
        indexTemplateFilePath,
        windowVar,
      );
      const transformedHtml = prefixIndexAssetUrls(
        applyKbWidgetToIndexHtml(
          applyAppNameToIndexHtml(
            html.replace(windowVar, windowScriptContent),
            process.env.APP_NAME,
          ),
          this.environmentService.getKbWidgetUrl(),
        ),
        publicPathPrefix,
      );

      fs.writeFileSync(indexFilePath, transformedHtml);

      const RENDER_PATH = '*';

      await app.register(fastifyStatic, {
        root: clientDistPath,
        wildcard: false,
      });

      // Caddy strips the public prefix, while direct access and some upstream
      // proxies preserve it. Serve build assets correctly in both topologies.
      if (publicPathPrefix) {
        await app.register(fastifyStatic, {
          root: clientDistPath,
          prefix: `${publicPathPrefix}/`,
          wildcard: false,
          decorateReply: false,
        });
      }

      app.get(RENDER_PATH, (req: any, res: any) => {
        const stream = fs.createReadStream(indexFilePath);
        res
          .header('Cache-Control', 'no-cache, no-store, must-revalidate')
          .type('text/html')
          .send(stream);
      });
    }
  }
}
