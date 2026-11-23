import { z } from 'zod';
import {
  HttpProviderAdapter,
  ProviderFailure,
  parseBody,
  tokenUsage,
  type HttpCall,
  type ProviderRequest,
  type ProviderResponse,
} from './adapter';

const API = 'https://generativelanguage.googleapis.com/v1beta';

const count = z.number().int().nonnegative().optional();

const GenerateContent = z.object({
  candidates: z
    .array(
      z.object({
        content: z.object({ parts: z.array(z.object({ text: z.string().optional() })).optional() }).optional(),
        finishReason: z.string().optional(),
      }),
    )
    .optional(),
  usageMetadata: z
    .object({ promptTokenCount: count, candidatesTokenCount: count, thoughtsTokenCount: count })
    .optional(),
  modelVersion: z.string().optional(),
});

export class GeminiAdapter extends HttpProviderAdapter {
  readonly id = 'gemini';
  protected readonly displayName = 'Google Gemini';

  /** The key travels in a header, not the URL, so it cannot end up in proxy or access logs. */
  protected chatCall(apiKey: string, model: string, request: ProviderRequest): HttpCall {
    return {
      url: `${API}/models/${encodeURIComponent(model)}:generateContent`,
      init: {
        method: 'POST',
        headers: { 'x-goog-api-key': apiKey, 'content-type': 'application/json' },
        body: JSON.stringify({
          ...(request.system === undefined ? {} : { systemInstruction: { parts: [{ text: request.system }] } }),
          contents: request.messages.map((message) => ({
            role: message.role === 'assistant' ? 'model' : 'user',
            parts: [{ text: message.content }],
          })),
          generationConfig: { maxOutputTokens: request.maxOutputTokens },
        }),
      },
    };
  }

  protected readChat(body: unknown, model: string): ProviderResponse {
    const result = parseBody(GenerateContent, body);
    const candidate = result.candidates?.[0];
    const parts = candidate?.content?.parts?.filter((part) => part.text !== undefined) ?? [];
    if (candidate === undefined || parts.length === 0) {
      const reason = candidate?.finishReason ?? 'no candidate';
      throw new ProviderFailure('bad_response', `the response contained no text (${reason})`);
    }
    const usage = result.usageMetadata;
    const output =
      usage === undefined ||
      (usage.candidatesTokenCount === undefined && usage.thoughtsTokenCount === undefined)
        ? undefined
        : (usage.candidatesTokenCount ?? 0) + (usage.thoughtsTokenCount ?? 0);
    return {
      text: parts.map((part) => part.text ?? '').join(''),
      model: result.modelVersion ?? model,
      finishReason: candidate.finishReason,
      usage: tokenUsage(usage?.promptTokenCount, output),
    };
  }

  protected verifyCall(apiKey: string): HttpCall {
    return {
      url: `${API}/models?pageSize=1`,
      init: { method: 'GET', headers: { 'x-goog-api-key': apiKey } },
    };
  }
}
