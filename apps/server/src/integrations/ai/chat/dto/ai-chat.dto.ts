import {
  ArrayMaxSize,
  IsArray,
  IsOptional,
  IsString,
  IsUUID,
  MaxLength,
  MinLength,
} from 'class-validator';

export class ChatIdDto {
  @IsUUID()
  chatId: string;
}

export class UpdateChatDto {
  @IsUUID()
  chatId: string;

  @IsString()
  @MinLength(1)
  @MaxLength(255)
  title: string;
}

export class SearchChatsDto {
  @IsString()
  @MaxLength(255)
  query: string;
}

export class SendChatDto {
  @IsOptional()
  @IsUUID()
  chatId?: string;

  @IsString()
  @MinLength(1)
  @MaxLength(100000)
  content: string;

  @IsOptional()
  @IsArray()
  @ArrayMaxSize(20)
  @IsUUID('all', { each: true })
  mentionedPageIds?: string[];

  @IsOptional()
  @IsUUID()
  contextPageId?: string;

  @IsOptional()
  @IsArray()
  @ArrayMaxSize(10)
  @IsUUID('all', { each: true })
  attachmentIds?: string[];
}
