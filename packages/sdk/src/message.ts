export interface SendMessageRequest {
  sessionId: string;
  executionId: string;
  revision: number;
  requestId: string;
  text: string;
}
export interface MessageDelivery {
  requestId: string;
  sessionId: string;
  executionId: string;
  state: 'submitting' | 'delivered' | 'delivery-unknown';
  messageId: string | null;
}
