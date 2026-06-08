import { IsInt, IsOptional, IsString, Max, Min, MinLength } from 'class-validator';

export class CreateAuctionDto {
  @IsString()
  @MinLength(1)
  productId!: string;

  @IsString()
  @MinLength(1)
  liveRoomId!: string;

  @IsInt()
  @Min(0)
  startPriceCent!: number;

  @IsInt()
  @Min(1)
  incrementCent!: number;

  @IsInt()
  @Min(1)
  capPriceCent!: number;

  @IsInt()
  @Min(1)
  @Max(86400)
  durationSec!: number;

  @IsOptional()
  @IsInt()
  @Min(1)
  extensionWindowSec?: number;

  @IsOptional()
  @IsInt()
  @Min(1)
  extensionSec?: number;
}

