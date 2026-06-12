import {
  ArrayNotEmpty,
  IsArray,
  IsIn,
  IsNotEmpty,
  IsOptional,
  IsString,
  IsUUID,
} from 'class-validator';
import { PageIdDto } from './page.dto';

export const PAGE_PERMISSION_ROLES = ['reader', 'writer'] as const;
export type PagePermissionRole = (typeof PAGE_PERMISSION_ROLES)[number];

export class AddPagePermissionDto extends PageIdDto {
  @IsIn(PAGE_PERMISSION_ROLES)
  role: PagePermissionRole;

  @IsOptional()
  @IsArray()
  @ArrayNotEmpty()
  @IsUUID('all', { each: true })
  userIds?: string[];

  @IsOptional()
  @IsArray()
  @ArrayNotEmpty()
  @IsUUID('all', { each: true })
  groupIds?: string[];
}

export class RemovePagePermissionDto extends PageIdDto {
  @IsOptional()
  @IsArray()
  @ArrayNotEmpty()
  @IsUUID('all', { each: true })
  userIds?: string[];

  @IsOptional()
  @IsArray()
  @ArrayNotEmpty()
  @IsUUID('all', { each: true })
  groupIds?: string[];
}

export class UpdatePagePermissionRoleDto extends PageIdDto {
  @IsIn(PAGE_PERMISSION_ROLES)
  role: PagePermissionRole;

  @IsOptional()
  @IsString()
  @IsNotEmpty()
  userId?: string;

  @IsOptional()
  @IsString()
  @IsNotEmpty()
  groupId?: string;
}
