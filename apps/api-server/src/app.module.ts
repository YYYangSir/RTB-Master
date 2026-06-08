import { Module } from '@nestjs/common';
import { AuthModule } from './auth/auth.module';
import { AuctionsModule } from './auctions/auctions.module';
import { HealthController } from './health.controller';
import { LiveRoomsModule } from './live-rooms/live-rooms.module';
import { OrdersModule } from './orders/orders.module';
import { PrismaModule } from './prisma/prisma.module';
import { ProductsModule } from './products/products.module';
import { UsersModule } from './users/users.module';

@Module({
  imports: [
    PrismaModule,
    AuthModule,
    ProductsModule,
    LiveRoomsModule,
    UsersModule,
    AuctionsModule,
    OrdersModule,
  ],
  controllers: [HealthController],
})
export class AppModule {}
