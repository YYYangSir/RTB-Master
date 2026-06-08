import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { OrderStatus } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';

@Injectable()
export class OrdersService {
  constructor(private readonly prisma: PrismaService) {}

  async findOne(id: string) {
    const order = await this.prisma.order.findUnique({
      where: { id },
      include: { auction: true, winner: true },
    });
    if (!order) {
      throw new NotFoundException('order not found');
    }
    return order;
  }

  async pay(id: string) {
    const order = await this.findOne(id);
    if (order.status === OrderStatus.PAID) {
      return order;
    }
    if (order.status !== OrderStatus.PENDING_PAYMENT) {
      throw new BadRequestException('order cannot be paid');
    }
    return this.prisma.order.update({
      where: { id },
      data: { status: OrderStatus.PAID },
      include: { auction: true, winner: true },
    });
  }
}
