import {
  IsIn,
  IsNotEmpty,
  IsOptional,
  IsString,
  IsUUID,
  MaxLength,
} from 'class-validator';
import { PageIdDto } from './page.dto';

export class ReviewQueueDto {
  @IsUUID()
  spaceId: string;
}

export class ReviewPageDto extends PageIdDto {
  @IsIn(['approve', 'reject'])
  action: 'approve' | 'reject';

  @IsOptional()
  @IsString()
  @IsNotEmpty()
  @MaxLength(2000)
  note?: string;
}
