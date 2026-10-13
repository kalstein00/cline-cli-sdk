import {mock} from 'node:test';
import {directRemote} from './direct-ssh.mjs';
directRemote({mock},process.env.CLINE_CHAT_FAULT==='launch-unknown'?{launchCode:255}:{});
await import('../../examples/chat/server.mjs');
