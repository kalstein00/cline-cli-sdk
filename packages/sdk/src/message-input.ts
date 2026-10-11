import type {Snapshot, PhaseObservation} from './reducer.js';

export interface MessageInputState {
  ready: boolean;
  reason: 'ready' | 'unsupported-profile' | 'not-connected' | 'history-unavailable' | 'delivery-pending' | 'interaction-pending' | 'agent-busy' | 'process-unconfirmed' | 'composer-unconfirmed';
  maxBytes: 112;
}

/** A process being alive is insufficient: the verified TUI must expose an idle composer. */
export function messageInput(state: Snapshot, supported: boolean, witness: PhaseObservation['terminalEvidence'], pendingTools: boolean, activePhase: boolean): MessageInputState {
  const process=state.executionEvidence;
  let reason: MessageInputState['reason'];
  if (!supported) reason='unsupported-profile';
  else if (!['connected','replay'].includes(state.connection)) reason='not-connected';
  else if (!state.historySync.current) reason='history-unavailable';
  else if ((state.messageDelivery && state.messageDelivery.state!=='delivered') || state.stop || (state.resume && state.resume.state!=='delivered') || (state.response && ['submitting','delivery-unknown'].includes(state.response.state))) reason='delivery-pending';
  else if (state.interaction || activePhase) reason='interaction-pending';
  else if (!process?.alive || !process.identityConfirmed || !process.supervisorAlive || process.trackingError) reason='process-unconfirmed';
  else if ((state.messageDelivery?.state==='delivered' && state.messages.at(-1)?.id===state.messageDelivery.messageId) || process.manifestStatus!=='idle' || process.children?.length || pendingTools) reason='agent-busy';
  else if (!state.sessionId || !state.composer || state.composer.text!=='' || !witness?.composerHash || witness.gap || witness.modalHash) reason='composer-unconfirmed';
  else reason='ready';
  return {ready:reason==='ready',reason,maxBytes:112};
}
