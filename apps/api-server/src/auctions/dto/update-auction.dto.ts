import { IsInt, IsOptional, Max, Min } from 'class-validator';

export class UpdateAuctionDto {
  @IsOptional()
  @IsInt()
  @Min(0)
  startPriceCent?: number;

  @IsOptional()
  @IsInt()
  @Min(1)
  incrementCent?: number;

  @IsOptional()
  @IsInt()
  @Min(1)
  capPriceCent?: number;

  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(86400)
  durationSec?: number;

  @IsOptional()
  @IsInt()
  @Min(1)
  extensionWindowSec?: number;

  @IsOptional()
  @IsInt()
  @Min(1)
  extensionSec?: number;
}
