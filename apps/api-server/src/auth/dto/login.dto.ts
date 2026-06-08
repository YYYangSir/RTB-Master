import { UserRole } from '@prisma/client';
import { IsEnum, IsString, MaxLength, MinLength } from 'class-validator';

export class LoginDto {
  @IsString()
  @MinLength(1)
  @MaxLength(50)
  nickname!: string;

  @IsEnum(UserRole)
  role!: UserRole;
}
