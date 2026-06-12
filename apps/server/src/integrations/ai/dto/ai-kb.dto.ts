import {
  IsBoolean,
  IsIn,
  IsNotEmpty,
  IsOptional,
  IsString,
  MaxLength,
} from 'class-validator';
import { KB_TYPES, KbType } from '../ai-kb.service';

export class UpsertKbConnectorDto {
  // Omitted = create; present = update existing connector.
  @IsOptional()
  @IsString()
  @MaxLength(50)
  id?: string;

  @IsIn(KB_TYPES)
  type: KbType;

  @IsString()
  @IsNotEmpty()
  @MaxLength(100)
  name: string;

  @IsString()
  @IsNotEmpty()
  @MaxLength(500)
  baseUrl: string;

  // Blank/omitted = keep the stored key.
  @IsOptional()
  @IsString()
  @MaxLength(500)
  apiKey?: string;

  @IsOptional()
  @IsBoolean()
  clearApiKey?: boolean;

  // Custom servers only: search path override (default /search).
  @IsOptional()
  @IsString()
  @MaxLength(200)
  searchPath?: string;

  @IsOptional()
  @IsBoolean()
  enabled?: boolean;

  // K3: mirror docmost content into this KB (cognee only).
  @IsOptional()
  @IsBoolean()
  sync?: boolean;
}

export class KbConnectorIdDto {
  @IsString()
  @IsNotEmpty()
  id: string;
}

/**
 * Test either a stored connector (id only) or a draft (type+baseUrl, with a
 * blank apiKey falling back to the stored one when id is also given).
 */
export class TestKbConnectorDto {
  @IsOptional()
  @IsString()
  @MaxLength(50)
  id?: string;

  @IsOptional()
  @IsIn(KB_TYPES)
  type?: KbType;

  @IsOptional()
  @IsString()
  @MaxLength(500)
  baseUrl?: string;

  @IsOptional()
  @IsString()
  @MaxLength(500)
  apiKey?: string;

  @IsOptional()
  @IsString()
  @MaxLength(200)
  searchPath?: string;
}
