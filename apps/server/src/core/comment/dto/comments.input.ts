import { IsBoolean, IsString, IsUUID } from 'class-validator';

export class PageIdDto {
  @IsString()
  pageId: string;
}

export class CommentIdDto {
  @IsUUID()
  commentId: string;
}

export class ResolveCommentDto {
  @IsUUID()
  commentId: string;

  @IsBoolean()
  resolved: boolean;
}
