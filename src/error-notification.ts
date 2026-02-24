import { createLogger } from './logger.js';

const logger = createLogger('error-notification');

export interface NotificationService {
  sendAlert(message: string): Promise<void>;
}

export class ErrorNotification {
  constructor(private notificationService: NotificationService) {}

  async notifyCriticalError(message: string): Promise<void> {
    logger.error(`Critical Error: ${message}`);
    try {
      await this.notificationService.sendAlert(message);
    } catch (error: unknown) {
      logger.error(`Failed to send alert: ${error}`);
    }
  }
}
