import test from 'node:test';
import assert from 'node:assert/strict';
import childProcess from 'node:child_process';
import {directRemote} from './support/direct-ssh.mjs';

function exampleEnvironment(t) {
  const saved = Object.fromEntries(Object.entries(process.env).filter(([name]) => name.startsWith('CLINE_SDK_')));
  for (const name of Object.keys(saved)) delete process.env[name];
  t.after(() => {
    for (const name of Object.keys(process.env)) if (name.startsWith('CLINE_SDK_')) delete process.env[name];
    Object.assign(process.env, saved);
  });
  process.env.CLINE_SDK_HOST = 'fixture';
}

test('retired control examples fail before any SSH or task creation', async t => {
  let calls = 0;
  t.mock.method(childProcess, 'spawn', () => { calls++; throw Error('No SSH allowed'); });
  for (const name of ['interactions', 'text', 'resume', 'structured']) {
    await assert.rejects(import(`../examples/node/${name}.mjs`), {code: 'remote-input-disabled', notSubmitted: true});
  }
  assert.equal(calls, 0);
});

test('live example observes once without waiting for an unsupported completion witness', async t => {
  exampleEnvironment(t);
  process.env.CLINE_SDK_WORKSPACE = '/work';
  const remote = directRemote(t);
  const output = [];
  t.mock.method(console, 'log', value => output.push(value));
  const previousExitCode = process.exitCode;
  t.after(() => { process.exitCode = previousExitCode; });
  await import('../examples/node/live.mjs');
  assert.equal(remote.commands.filter(item => item.command.includes("'new-session'")).length, 1);
  assert.equal(remote.commands.filter(item => item.command.includes("'capture-pane'")).length, 1);
  const snapshot = output.map(value => { try { return JSON.parse(value).snapshot; } catch {} }).find(Boolean);
  assert.equal(snapshot.execution, 'unknown');
  assert.equal(snapshot.remoteObservation.kind, 'tmux');
  assert.equal(process.exitCode, previousExitCode);
});

test('reconnect example lists history without implicitly selecting a conversation', async t => {
  exampleEnvironment(t);
  const remote = directRemote(t);
  t.mock.method(console, 'log', () => {});
  await import('../examples/node/reconnect.mjs');
  assert.equal(remote.commands.some(item => item.command.includes('head -c') || item.command.includes("'capture-pane'")), false);
});
