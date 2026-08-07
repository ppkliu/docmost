import {
  IsArray,
  IsBoolean,
  IsIn,
  IsInt,
  IsOptional,
  IsString,
  MaxLength,
} from 'class-validator';

export class AiSettingsDto {
  @IsOptional()
  @IsIn(['openai', 'openai-compatible', 'gemini', 'ollama'])
  driver?: string;

  @IsOptional()
  @IsString()
  @MaxLength(500)
  baseUrl?: string;

  // Optional: only when embeddings live behind a different endpoint than
  // completions. Blank = same as baseUrl.
  @IsOptional()
  @IsString()
  @MaxLength(500)
  embeddingBaseUrl?: string;

  // Blank/omitted = keep the existing stored key.
  @IsOptional()
  @IsString()
  @MaxLength(500)
  apiKey?: string;

  @IsOptional()
  @IsString()
  @MaxLength(200)
  completionModel?: string;

  @IsOptional()
  @IsString()
  @MaxLength(200)
  embeddingModel?: string;

  @IsOptional()
  @IsInt()
  embeddingDimension?: number;

  // Deletes the stored apiKey override (falls back to env).
  @IsOptional()
  @IsBoolean()
  clearApiKey?: boolean;
}

/**
 * Draft-config probe: same fields as AiSettingsDto, merged over the stored
 * workspace config + env, so admins can test before saving.
 */
export class AiTestDto extends AiSettingsDto {
  @IsOptional()
  @IsArray()
  @IsIn(['completion', 'embedding'], { each: true })
  targets?: ('completion' | 'embedding')[];
}
