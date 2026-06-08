import { createHmac, timingSafeEqual } from 'node:crypto';
import { Injectable, UnauthorizedException } from '@nestjs/common';
import { UserRole } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { LoginDto } from './dto/login.dto';

@Injectable()
export class AuthService {
  private readonly secret = process.env.JWT_SECRET ?? 'replace-with-local-secret';

  constructor(private readonly prisma: PrismaService) {}

  async login(dto: LoginDto) {
    const user = await this.prisma.user.create({
      data: {
        nickname: dto.nickname,
        role: dto.role,
      },
    });
    return {
      token: this.sign(user.id),
      user,
    };
  }

  async authenticate(token: string) {
    const userId = this.verify(token);
    const user = await this.prisma.user.findUnique({ where: { id: userId } });
    if (!user) throw new UnauthorizedException('invalid token user');
    return user;
  }

  private sign(userId: string) {
    return `${userId}.${this.signature(userId)}`;
  }

  private verify(token: string) {
    const [userId, signature] = token.split('.');
    if (!userId || !signature) throw new UnauthorizedException('invalid token');
    const expected = this.signature(userId);
    const actualBuffer = Buffer.from(signature);
    const expectedBuffer = Buffer.from(expected);
    if (
      actualBuffer.length !== expectedBuffer.length ||
      !timingSafeEqual(actualBuffer, expectedBuffer)
    ) {
      throw new UnauthorizedException('invalid token');
    }
    return userId;
  }

  private signature(userId: string) {
    return createHmac('sha256', this.secret).update(userId).digest('hex');
  }
}

export type AuthUser = {
  id: string;
  nickname: string;
  role: UserRole;
};
