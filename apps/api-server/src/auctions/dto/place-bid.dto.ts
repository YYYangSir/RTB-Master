import { IsInt, IsString, Max, Min, MinLength } from 'class-validator';

export class PlaceBidDto {
  @IsString()
  @MinLength(1)
  requestId!: string;

  @IsString()
  @MinLength(1)
  userId!: string;

  @IsInt()
  @Min(0)
  @Max(1000000000)
  amountCent!: number;
}
