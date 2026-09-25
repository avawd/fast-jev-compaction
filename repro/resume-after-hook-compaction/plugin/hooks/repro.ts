import type { On, Register } from 'claude-code';

// The smallest session.compact hook that keeps rows: every message goes back as the engine's own.
export const register: Register = (on: On) => {
  on('session.compact', async ($, event) => {
    $.ui.log(`resume-repro: returning ${event.messages.length} messages unchanged`);
    return { messages: event.messages };
  });
};
