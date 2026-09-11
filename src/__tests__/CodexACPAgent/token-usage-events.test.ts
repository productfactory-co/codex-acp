import {CodexEventHandler} from "../../CodexEventHandler";
import type {AcpClientConnection} from "../../ACPSessionConnection";
import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { ServerNotification } from '../../app-server';
import { createCodexMockTestFixture, createTestSessionState, type CodexMockTestFixture } from '../acp-test-utils';
import type { TokenUsageBreakdown } from '../../app-server/v2';

function createTokenUsageNotification(
    sessionId: string,
    tokenUsage: {
        total: TokenUsageBreakdown;
        last: TokenUsageBreakdown;
        modelContextWindow: number | null;
    }
): ServerNotification {
    return {
        method: 'thread/tokenUsage/updated',
        params: {
            threadId: sessionId,
            turnId: 'turn-id',
            tokenUsage,
        },
    };
}

describe('Token Usage Events', () => {
    let mockFixture: CodexMockTestFixture;
    const sessionId = 'test-session-id';

    beforeEach(() => {
        mockFixture = createCodexMockTestFixture();
        vi.clearAllMocks();
    });
    describe('PromptResponse usage', () => {
        function setupPromptWithTokenUsage(notifications: ServerNotification[], turnStatus: string = "completed") {
            const codexAcpAgent = mockFixture.getCodexAcpAgent();

            mockFixture.getCodexAppServerClient().turnStart = vi.fn().mockResolvedValue({
                turn: { id: "turn-id", items: [], status: "inProgress", error: null }
            });

            // awaitTurnCompleted sends notifications before resolving
            mockFixture.getCodexAppServerClient().awaitTurnCompleted = vi.fn().mockImplementation(async () => {
                // Send notifications during turn (after handler is registered)
                for (const notification of notifications) {
                    mockFixture.sendServerNotification(notification);
                }
                return {
                    threadId: sessionId,
                    turn: { id: "turn-id", items: [], status: turnStatus, error: null }
                };
            });

            vi.spyOn(codexAcpAgent, 'getSessionState').mockReturnValue(createTestSessionState({ sessionId }));

            return codexAcpAgent;
        }

        it('should include token_count in PromptResponse on end_turn', async () => {
            const tokenUsageNotification = createTokenUsageNotification(sessionId, {
                total: {
                    totalTokens: 5000,
                    inputTokens: 4000,
                    cachedInputTokens: 1000,
                    cacheWriteInputTokens: 0,
                    outputTokens: 900,
                    reasoningOutputTokens: 100,
                },
                last: {
                    totalTokens: 2500,
                    inputTokens: 2000,
                    cachedInputTokens: 500,
                    cacheWriteInputTokens: 0,
                    outputTokens: 450,
                    reasoningOutputTokens: 50,
                },
                modelContextWindow: 128000,
            });

            const codexAcpAgent = setupPromptWithTokenUsage([tokenUsageNotification]);

            const response = await codexAcpAgent.prompt({
                sessionId,
                prompt: [{ type: 'text', text: 'test prompt' }],
            });

            await expect(`${JSON.stringify(response, null, 2)}\n`).toMatchFileSnapshot(
                'data/token-usage-end-turn.json'
            );
        });

        it('should include token_count in PromptResponse on cancelled', async () => {
            const tokenUsageNotification = createTokenUsageNotification(sessionId, {
                total: {
                    totalTokens: 3000,
                    inputTokens: 2500,
                    cachedInputTokens: 0,
                    cacheWriteInputTokens: 0,
                    outputTokens: 500,
                    reasoningOutputTokens: 0,
                },
                last: {
                    totalTokens: 1500,
                    inputTokens: 1200,
                    cachedInputTokens: 0,
                    cacheWriteInputTokens: 0,
                    outputTokens: 300,
                    reasoningOutputTokens: 0,
                },
                modelContextWindow: 128000,
            });

            const codexAcpAgent = setupPromptWithTokenUsage([tokenUsageNotification], "interrupted");

            const response = await codexAcpAgent.prompt({
                sessionId,
                prompt: [{ type: 'text', text: 'test prompt' }],
            });

            await expect(`${JSON.stringify(response, null, 2)}\n`).toMatchFileSnapshot(
                'data/token-usage-cancelled.json'
            );
        });

        it('should return null token_count when no token usage event received', async () => {
            const codexAcpAgent = setupPromptWithTokenUsage([]);

            const response = await codexAcpAgent.prompt({
                sessionId,
                prompt: [{ type: 'text', text: 'test prompt' }],
            });

            await expect(`${JSON.stringify(response, null, 2)}\n`).toMatchFileSnapshot(
                'data/token-usage-null.json'
            );
        });

        it('should account for every model round in a prompt', async () => {
            const notifications: ServerNotification[] = [
                createTokenUsageNotification(sessionId, {
                    total: { totalTokens: 1000, inputTokens: 800, cachedInputTokens: 0, cacheWriteInputTokens: 0, outputTokens: 200, reasoningOutputTokens: 0 },
                    last: { totalTokens: 1000, inputTokens: 800, cachedInputTokens: 0, cacheWriteInputTokens: 0, outputTokens: 200, reasoningOutputTokens: 0 },
                    modelContextWindow: 128000,
                }),
                createTokenUsageNotification(sessionId, {
                    total: { totalTokens: 2000, inputTokens: 1600, cachedInputTokens: 0, cacheWriteInputTokens: 0, outputTokens: 400, reasoningOutputTokens: 0 },
                    last: { totalTokens: 1000, inputTokens: 800, cachedInputTokens: 0, cacheWriteInputTokens: 0, outputTokens: 200, reasoningOutputTokens: 0 },
                    modelContextWindow: 128000,
                }),
                createTokenUsageNotification(sessionId, {
                    total: { totalTokens: 3500, inputTokens: 2800, cachedInputTokens: 500, cacheWriteInputTokens: 0, outputTokens: 600, reasoningOutputTokens: 100 },
                    last: { totalTokens: 1500, inputTokens: 1200, cachedInputTokens: 500, cacheWriteInputTokens: 0, outputTokens: 200, reasoningOutputTokens: 100 },
                    modelContextWindow: 128000,
                }),
            ];

            const codexAcpAgent = setupPromptWithTokenUsage(notifications);

            const response = await codexAcpAgent.prompt({
                sessionId,
                prompt: [{ type: 'text', text: 'test prompt' }],
            });

            await expect(`${JSON.stringify(response, null, 2)}\n`).toMatchFileSnapshot(
                'data/token-usage-multiple-updates.json'
            );
        });
    });

    it('separates successive prompts and ignores duplicate usage notifications', async () => {
        const agent = mockFixture.getCodexAcpAgent();
        const state = createTestSessionState({sessionId});
        vi.spyOn(agent, 'getSessionState').mockReturnValue(state);
        mockFixture.getCodexAppServerClient().turnStart = vi.fn().mockResolvedValue({
            turn: {id: "turn-id", items: [], status: "inProgress", error: null},
        });
        const breakdown = (input: number, output: number): TokenUsageBreakdown => ({
            totalTokens: input + output, inputTokens: input, outputTokens: output,
            cachedInputTokens: 0, cacheWriteInputTokens: 0, reasoningOutputTokens: 0,
        });
        let notifications = [
            createTokenUsageNotification(sessionId, {total: breakdown(100, 10), last: breakdown(100, 10), modelContextWindow: 10000}),
            createTokenUsageNotification(sessionId, {total: breakdown(300, 30), last: breakdown(200, 20), modelContextWindow: 10000}),
        ];
        notifications.push(notifications[1]!);
        mockFixture.getCodexAppServerClient().awaitTurnCompleted = vi.fn().mockImplementation(async () => {
            for (const notification of notifications) mockFixture.sendServerNotification(notification);
            return {threadId: sessionId, turn: {id: "turn-id", items: [], status: "completed", error: null}};
        });
        const prompt = {sessionId, prompt: [{type: 'text' as const, text: 'test'}]};
        expect((await agent.prompt(prompt)).usage).toMatchObject({inputTokens: 300, outputTokens: 30, totalTokens: 330});
        expect(state.lastTokenUsage?.totalTokens).toBe(220);
        expect(state.modelContextWindow).toBe(10000);
        notifications = [createTokenUsageNotification(sessionId, {
            total: breakdown(600, 60), last: breakdown(300, 30), modelContextWindow: 10000,
        })];
        expect((await agent.prompt(prompt)).usage).toMatchObject({inputTokens: 300, outputTokens: 30, totalTokens: 330});
        // A cold-loaded session has no baseline. Its first response must not bill
        // the historical cumulative total again.
        state.totalTokenUsage = null;
        delete state.tokenUsageByThread;
        notifications = [createTokenUsageNotification(sessionId, {
            total: breakdown(10000, 1000), last: breakdown(50, 5), modelContextWindow: 10000,
        })];
        expect((await agent.prompt(prompt)).usage).toMatchObject({inputTokens: 50, outputTokens: 5, totalTokens: 55});
        // A regressing counter cannot be silently treated as complete accounting.
        notifications = [createTokenUsageNotification(sessionId, {
            total: breakdown(10, 1), last: breakdown(10, 1), modelContextWindow: 10000,
        })];
        expect((await agent.prompt(prompt)).usage).toBeNull();
    });

    it('counts interleaved root and child counters independently', async () => {
        const state = createTestSessionState({sessionId});
        const notify = vi.fn(async () => {});
        const handler = new CodexEventHandler({notify} as unknown as AcpClientConnection, state);
        const breakdown = (tokens: number): TokenUsageBreakdown => ({totalTokens: tokens, inputTokens: tokens,
            outputTokens: 0, cachedInputTokens: 0, cacheWriteInputTokens: 0, reasoningOutputTokens: 0});
        const event = (threadId: string, total: number, last: number) => createTokenUsageNotification(threadId, {
            total: breakdown(total), last: breakdown(last), modelContextWindow: threadId === sessionId ? 10000 : 5000,
        });
        await handler.handleNotification(event(sessionId, 1000, 1000));
        await handler.handleNotification(event('child', 100, 100));
        await handler.handleNotification(event(sessionId, 2000, 1000));
        await handler.handleNotification(event('child', 200, 100));
        await handler.handleNotification(event('child', 200, 100));
        expect(state.promptTokenUsage?.totalTokens).toBe(2200);
        expect(state.promptUsageIncomplete).toBe(false);
        expect(state.totalTokenUsage?.totalTokens).toBe(2000);
        expect(state.lastTokenUsage?.totalTokens).toBe(1000);
        expect(state.modelContextWindow).toBe(10000);
        state.promptTokenUsage = null;
        await handler.handleNotification(event('child', 300, 100));
        await handler.handleNotification(event(sessionId, 2500, 500));
        expect(state.promptTokenUsage).toMatchObject({totalTokens: 600});
    });

    describe('session/update usage_update', () => {
        function setupPromptAndReturnEvents(notifications: ServerNotification[], turnStatus: string = "completed") {
            const codexAcpAgent = mockFixture.getCodexAcpAgent();

            mockFixture.getCodexAppServerClient().turnStart = vi.fn().mockResolvedValue({
                turn: { id: "turn-id", items: [], status: "inProgress", error: null }
            });

            mockFixture.getCodexAppServerClient().awaitTurnCompleted = vi.fn().mockImplementation(async () => {
                for (const notification of notifications) {
                    mockFixture.sendServerNotification(notification);
                }
                return {
                    threadId: sessionId,
                    turn: { id: "turn-id", items: [], status: turnStatus, error: null }
                };
            });

            vi.spyOn(codexAcpAgent, 'getSessionState').mockReturnValue(createTestSessionState({ sessionId }));

            return async () => {
                await codexAcpAgent.prompt({
                    sessionId,
                    prompt: [{ type: 'text', text: 'test prompt' }],
                });
                return mockFixture.getAcpConnectionEvents([]);
            };
        }

        it('should emit usage_update with latest turn usage as a context proxy', async () => {
            const events = await setupPromptAndReturnEvents([
                createTokenUsageNotification(sessionId, {
                    total: {
                        totalTokens: 5000,
                        inputTokens: 4000,
                        cachedInputTokens: 1000,
                        cacheWriteInputTokens: 0,
                        outputTokens: 900,
                        reasoningOutputTokens: 100,
                    },
                    last: {
                        totalTokens: 2500,
                        inputTokens: 2000,
                        cachedInputTokens: 500,
                        cacheWriteInputTokens: 0,
                        outputTokens: 450,
                        reasoningOutputTokens: 50,
                    },
                    modelContextWindow: 128000,
                }),
            ])();

            await expect(`${JSON.stringify(events[0], null, 2)}\n`).toMatchFileSnapshot('data/token-usage-session-update.json');
        });

        it('should emit latest turn usage from multiple updates', async () => {
            const events = await setupPromptAndReturnEvents([
                createTokenUsageNotification(sessionId, {
                    total: { totalTokens: 1000, inputTokens: 800, cachedInputTokens: 0, cacheWriteInputTokens: 0, outputTokens: 200, reasoningOutputTokens: 0 },
                    last: { totalTokens: 1000, inputTokens: 800, cachedInputTokens: 0, cacheWriteInputTokens: 0, outputTokens: 200, reasoningOutputTokens: 0 },
                    modelContextWindow: 128000,
                }),
                createTokenUsageNotification(sessionId, {
                    total: { totalTokens: 2000, inputTokens: 1600, cachedInputTokens: 0, cacheWriteInputTokens: 0, outputTokens: 400, reasoningOutputTokens: 0 },
                    last: { totalTokens: 1000, inputTokens: 800, cachedInputTokens: 0, cacheWriteInputTokens: 0, outputTokens: 200, reasoningOutputTokens: 0 },
                    modelContextWindow: 128000,
                }),
                createTokenUsageNotification(sessionId, {
                    total: { totalTokens: 3500, inputTokens: 2800, cachedInputTokens: 500, cacheWriteInputTokens: 0, outputTokens: 600, reasoningOutputTokens: 100 },
                    last: { totalTokens: 1500, inputTokens: 1200, cachedInputTokens: 500, cacheWriteInputTokens: 0, outputTokens: 200, reasoningOutputTokens: 100 },
                    modelContextWindow: 128000,
                }),
            ])();

            await expect(`${JSON.stringify(events, null, 2)}\n`).toMatchFileSnapshot('data/token-usage-session-update-multiple.json');
        });

        it('should skip usage_update when model context window is unavailable', async () => {
            const events = await setupPromptAndReturnEvents([
                createTokenUsageNotification(sessionId, {
                    total: { totalTokens: 5000, inputTokens: 4000, cachedInputTokens: 1000, cacheWriteInputTokens: 0, outputTokens: 900, reasoningOutputTokens: 100 },
                    last: { totalTokens: 2500, inputTokens: 2000, cachedInputTokens: 500, cacheWriteInputTokens: 0, outputTokens: 450, reasoningOutputTokens: 50 },
                    modelContextWindow: null,
                }),
            ])();

            expect(events).toEqual([]);
        });
    });
});
