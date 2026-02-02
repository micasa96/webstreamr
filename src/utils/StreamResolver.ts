// src/utils/StreamResolver.ts
import bytes from 'bytes';
import { ContentType, Stream } from 'stremio-addon-sdk';
import winston from 'winston';
import { logErrorAndReturnNiceString } from '../error';
import { ExtractorRegistry } from '../extractor';
import { Source } from '../source';
import { Context, Format, UrlResult } from '../types';
import { showErrors, showExternalUrls } from './config';
import { envGetAppName } from './env';
import { Id } from './id';
import { flagFromCountryCode } from './language';

interface ResolveResponse {
  streams: Stream[];
  ttl?: number;
}

// ✅ Extender el tipo Stream para incluir campos personalizados
interface ExtendedStream extends Stream {
  quality?: string;
  resolution?: string;
}

export class StreamResolver {
  private readonly logger: winston.Logger;
  private readonly extractorRegistry: ExtractorRegistry;

  public constructor(logger: winston.Logger, extractorRegistry: ExtractorRegistry) {
    this.logger = logger;
    this.extractorRegistry = extractorRegistry;
  }

  public async resolve(
    ctx: Context,
    sources: Source[],
    type: ContentType,
    id: Id
  ): Promise<ResolveResponse> {
    const startTime = Date.now();

    if (sources.length === 0) {
      return {
        streams: [
          {
            name: 'WebStreamr',
            title: '⚠️ No se encontraron fuentes. Por favor, reconfigure el complemento.',
            externalUrl: ctx.hostUrl.href,
          },
        ],
      };
    }

    const allUrlResults: UrlResult[] = [];
    // ✅ Mejora del código 2: streams de error visibles para el usuario
    const errorStreams: Stream[] = [];
    let sourceErrorCount = 0;

    // Priorizar fuentes específicas como en el mod
    const prioritySourceIds = ['embed69', 'pelisplus4k', 'cinehdplus', 'xupalace'];
    const prioritizedSources = sources
      .filter(s => prioritySourceIds.includes(s.id))
      .sort((a, b) => prioritySourceIds.indexOf(a.id) - prioritySourceIds.indexOf(b.id));
    const otherSources = sources.filter(s => !prioritySourceIds.includes(s.id));

    const handleSource = async (source: Source) => {
      if (!source.contentTypes.includes(type)) return;
      try {
        this.logger.info(`🔍 Procesando fuente: ${source.id}`, ctx);
        const sourceResults = await source.handle(ctx, type, id);

        const urlResults = (
          await Promise.all(
            sourceResults.map(async ({ url, meta }) => {
              try {
                return await this.extractorRegistry.handle(ctx, url, {
                  ...meta,
                  sourceLabel: meta?.sourceLabel || source.label,
                  sourceId: meta?.sourceId || source.id,
                });
              } catch (e) {
                this.logger.debug(`⚠️ Extractor falló para ${url.href}: ${e instanceof Error ? e.message : String(e)}`, ctx);
                return [];
              }
            })
          )
        ).flat();

        allUrlResults.push(...urlResults);
      } catch (error) {
        sourceErrorCount++;
        this.logger.warn(`⚠️ Fuente ${source.id} falló`, { error, ...ctx });

        // ✅ Mejora del código 2: mostrar error de fuente al usuario si showErrors está activo
        if (showErrors(ctx.config)) {
          errorStreams.push({
            name: envGetAppName(),
            title: [`🔗 ${source.label}`, logErrorAndReturnNiceString(ctx, this.logger, source.id, error)].join('\n'),
            externalUrl: source.baseUrl,
          });
        }
      }
    };

    // Procesar las prioritarias de forma SECUENCIAL para permitir el corte temprano
    for (const source of prioritizedSources) {
      const resultsBefore = allUrlResults.filter(r => !r.error).length;
      await handleSource(source);
      const resultsAfter = allUrlResults.filter(r => !r.error).length;
      const resultsFromThisSource = resultsAfter - resultsBefore;

      if (type === 'movie') {
        if (resultsFromThisSource > 0) {
          this.logger.info(`🎯 Corte temprano (Pelicula): Fuente ${source.id} devolvió ${resultsFromThisSource} resultados. Deteniendo búsqueda de fuentes prioritarias.`, ctx);
          break;
        }
      } else {
        // Regla para series: detener si ya tenemos 2 o más resultados totales
        if (resultsAfter >= 2) {
          this.logger.info(`🎯 Corte temprano (Serie): Total acumulado de ${resultsAfter} resultados. Deteniendo búsqueda adicional.`, ctx);
          break;
        }
      }
    }

    // Si después de las prioritarias aún no hay NADA (para movie) o menos de 2 (para series),
    // intentar con las demás fuentes en paralelo
    const finalCountPrioritized = allUrlResults.filter(r => !r.error).length;
    const minNeededForParallel = type === 'movie' ? 1 : 2;

    if (finalCountPrioritized < minNeededForParallel && otherSources.length > 0) {
      this.logger.info(`⏩ Resultados insuficientes (${finalCountPrioritized}/${minNeededForParallel}). Intentando con el resto de fuentes...`, ctx);
      await Promise.all(otherSources.map(s => handleSource(s)));
    }

    const errorCount = allUrlResults.filter(r => r.error).length;

    const endTime = Date.now();
    const durationMs = endTime - startTime;
    const durationSec = (durationMs / 1000).toFixed(2);

    this.logger.info(`📊 Final: ${allUrlResults.length} resultados de URL (${errorCount} errores) - Tiempo total: ${durationSec}s`, ctx);

    // ✅ Mejora del código 2: ordenar resultados por altura, bytes y nombre
    allUrlResults.sort((a, b) => {
      if (a.error || b.error) {
        return a.error ? 1 : -1;
      }

      if (a.isExternal || b.isExternal) {
        return a.isExternal ? 1 : -1;
      }

      const heightComparison = (b.meta?.height ?? 0) - (a.meta?.height ?? 0);
      if (heightComparison !== 0) {
        return heightComparison;
      }

      const bytesComparison = (b.meta?.bytes ?? 0) - (a.meta?.bytes ?? 0);
      if (bytesComparison !== 0) {
        return bytesComparison;
      }

      return a.label.localeCompare(b.label);
    });

    const streams: ExtendedStream[] = [
      // ✅ Mejora del código 2: agregar streams de error de fuentes al inicio
      ...errorStreams,
      ...allUrlResults
        .filter(urlResult => !urlResult.error || showErrors(ctx.config))
        .map(urlResult => {
          const qualityLabel = this.mapHeightToQualityLabel(urlResult.meta?.height);
          const title = this.buildTitle(ctx, urlResult);
          const countryCode = urlResult.meta?.countryCodes?.[0] || 'Unknown';

          // Lógica de limpieza para filenames del mod
          const sourceNameMatch = title.split('\n')[0]?.match(/🔗 ([^(]+)/);
          const sourceName = sourceNameMatch ? (sourceNameMatch[1]?.trim() || 'Unknown') : 'Unknown';
          const cleanSourceName = sourceName.replace(/[^a-zA-Z0-9]/g, '');
          const cleanCountryCode = countryCode.substring(0, 2).toUpperCase();
          const sizeLabel = urlResult.meta?.bytes ? `[${bytes.format(urlResult.meta.bytes, { unitSeparator: ' ' })}]` : '';

          const filename = `${qualityLabel || 'Unknown'}.${cleanSourceName}.${cleanCountryCode}${sizeLabel ? '.' + sizeLabel : ''}.mkv`;

          return {
            ...this.buildUrl(urlResult),
            name: this.buildName(ctx, urlResult),
            title: title,
            behaviorHints: {
              bingeGroup: `webstreamr-${urlResult.meta?.sourceId}`,
              // ✅ Mejora del código 2: notWebReady dinámico según formato y protocolo
              ...((urlResult.format !== Format.mp4 || urlResult.url.protocol !== 'https:') && { notWebReady: true }),
              ...(urlResult.requestHeaders !== undefined && {
                notWebReady: true,
                proxyHeaders: { request: urlResult.requestHeaders },
              }),
              ...(urlResult.meta?.bytes && { videoSize: urlResult.meta.bytes }),
              filename,
            },
            type: 'hls',
            ...(qualityLabel && { quality: qualityLabel }),
            ...(qualityLabel && { resolution: this.mapQualityToResolutionLabel(qualityLabel) }),
          };
        }),
    ];

    // ✅ Mejora del código 2: TTL más robusto, no cachear si hubo errores de fuente
    const ttl = sourceErrorCount === 0 ? this.determineTtl(allUrlResults) : undefined;

    return {
      streams,
      ...(ttl && { ttl }),
    };
  }

  // ✅ Mejora del código 2: método dedicado para calcular TTL
  private determineTtl(urlResults: UrlResult[]): number | undefined {
    if (!urlResults.length) {
      return 900000; // 15m
    }

    if (urlResults.some(urlResult => urlResult.ttl === undefined)) {
      return undefined;
    }

    return Math.min(...urlResults.map(urlResult => urlResult.ttl as number));
  }

  private mapHeightToQualityLabel(height?: number): string | undefined {
    if (height === undefined) return undefined;
    if (height >= 2160) return '2160p';
    if (height >= 1440) return '1440p';
    if (height >= 1080) return '1080p';
    if (height >= 720) return '720p';
    if (height >= 576) return '576p';
    if (height >= 480) return '480p';
    if (height >= 360) return '360p';
    if (height >= 240) return '240p';
    return '240p';
  }

  private mapQualityToResolutionLabel(quality: string): string {
    switch (quality) {
      case '2160p': return '4K';
      case '1440p': return 'QHD';
      case '1080p': return 'FHD';
      case '720p': return 'HD';
      case '576p': return 'SD';
      case '480p': return 'SD';
      case '360p': return 'SD';
      default: return 'n/a';
    }
  }

  private buildUrl(urlResult: UrlResult): { externalUrl: string } | { url: string } | { ytId: string } {
    if (urlResult.ytId) return { ytId: urlResult.ytId };
    if (!urlResult.isExternal) return { url: urlResult.url.href };
    return { externalUrl: urlResult.url.href };
  }

  private buildName(ctx: Context, urlResult: UrlResult): string {
    let name = envGetAppName();
    urlResult.meta?.countryCodes?.forEach(cc => {
      name += ` ${flagFromCountryCode(cc)}`;
    });
    const quality = this.mapHeightToQualityLabel(urlResult.meta?.height);
    if (quality) {
      name += ` ${quality.replace('p', 'P')}`;
    }
    name += ` ⏳`;
    if (urlResult.isExternal && showExternalUrls(ctx.config)) {
      name += ` ⚠️ external`;
    }
    return name;
  }

  // ✅ Mejora del código 2: incluir meta.title como primera línea si existe
  private buildTitle(ctx: Context, urlResult: UrlResult): string {
    const titleLines = [];

    if (urlResult.meta?.title) {
      titleLines.push(urlResult.meta.title);
    }

    const label = urlResult.label || 'Stream';
    const sourceLabel = urlResult.meta?.sourceLabel || 'Unknown';
    titleLines.push(`🔗 ${label} from ${sourceLabel}`);

    if (urlResult.meta?.bytes) {
      titleLines.push(`💾 ${bytes.format(urlResult.meta.bytes, { unitSeparator: ' ' })}`);
    }
    if (urlResult.error) {
      titleLines.push(logErrorAndReturnNiceString(ctx, this.logger, urlResult.meta?.sourceId || '', urlResult.error));
    }
    return titleLines.join('\n');
  }
}
