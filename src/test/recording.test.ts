import assert from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as vscode from 'vscode';
import { RecordingTelemetry, TelemetryEvent } from '../telemetry';

suite('recording mode', () => {
	let tempDir: string;
	let channel: vscode.OutputChannel;

	setup(() => {
		tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'vscode-flowr-recording-test-'));
		channel = vscode.window.createOutputChannel('flowR recording test');
	});

	teardown(() => {
		channel.dispose();
		fs.rmSync(tempDir, { recursive: true, force: true });
	});

	test('writes a chronological timeline as a valid json file', () => {
		const filePath = path.join(tempDir, 'nested', 'mwe-recording.json');
		const recording = new RecordingTelemetry(channel, filePath);
		recording.start('mwe');
		recording.event(TelemetryEvent.UsedCommand, { command: 'vscode-flowr.slice.cursor' });
		recording.event(TelemetryEvent.ChangedSelection, { document: 'file:///demo.R', selections: [new vscode.Selection(0, 0, 1, 2)] });
		recording.stop();

		const parsed = JSON.parse(fs.readFileSync(filePath, 'utf8')) as { acronym: string, started: string, stopped: string, events: { event: string, timestamp: number }[] };
		assert.equal(parsed.acronym, 'mwe');
		assert.ok(parsed.started && parsed.stopped, 'start/stop timestamps are part of the file');
		const timestamps = parsed.events.map(e => e.timestamp);
		assert.deepEqual([...timestamps].sort((a, b) => a - b), timestamps, 'events form a chronological timeline');
		const kinds = parsed.events.map(e => e.event);
		assert.ok(kinds.includes('used-command'), `expected a used-command entry, got: ${kinds.join(', ')}`);
		assert.ok(kinds.includes('changed-selection'));
	});

	test('ignores events after stop and stays parseable', () => {
		const filePath = path.join(tempDir, 'post-stop.json');
		const recording = new RecordingTelemetry(channel, filePath);
		recording.start('acr');
		recording.stop();
		recording.event(TelemetryEvent.UsedCommand, { command: 'too-late' });
		recording.stop();

		const parsed = JSON.parse(fs.readFileSync(filePath, 'utf8')) as { events: { event: string, command?: string }[] };
		assert.ok(!parsed.events.some(e => e.command === 'too-late'));
	});
});
