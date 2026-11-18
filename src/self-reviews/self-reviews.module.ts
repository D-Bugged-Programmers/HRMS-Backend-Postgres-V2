import { Module } from '@nestjs/common';
import { SelfReviewsController } from './self-reviews.controller';
import { SelfReviewsService } from './self-reviews.service';
import { PerformanceRatingsModule } from '../performance-ratings/performance-ratings.module';
import { NotificationsModule } from '../notifications/notifications.module';

@Module({
  imports: [PerformanceRatingsModule, NotificationsModule],
  controllers: [SelfReviewsController],
  providers: [SelfReviewsService],
})
export class SelfReviewsModule {}
