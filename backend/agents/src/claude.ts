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

const API = 'https://api.anthropic.com/v1';
const API_VERSION = '2023-06-01';

const Message = z.object({
  model: z.string().optional(),
  content: z.array(z.object({ type: z.string(), text: z.string().optional() })),
  stop_reason: z.string().nullable().optional(),
  usage: z
    .object({
      input_tokens: z.number().int().nonnegative().optional(),
      output_tokens: z.number().int().nonnegative().optional(),
    })
    .optional(),
});

export class ClaudeAdapter extends HttpProviderAdapter {
  readonly id = 'anthropic';
  protected readonly displayName = 'Anthropic Claude';

  protected chatCall(apiKey: string, model: string, request: ProviderRequest): HttpCall {
    return {
      url: `${API}/messages`,
      init: {
        method: 'POST',
        headers: {
          'x-api-key': apiKey,
          'anthropic-version': API_VERSION,
          'content-type': 'application/json',
        },
        body: JSON.stringify({
          model,
          max_tokens: request.maxOutputTokens,
          ...(request.system === undefined ? {} : { system: request.system }),
          messages: request.messages,
        }),
      },
    };
  }

  protected readChat(body: unknown, model: string): ProviderResponse {
    const message = parseBody(Message, body);
    const blocks = message.content.filter((block) => block.type === 'text');
    if (blocks.length === 0) {
      throw new ProviderFailure('bad_response', 'the response contained no text block');
    }
    const text = blocks.map((block) => block.text ?? '').join('');
    return {
      text,
      model: message.model ?? model,
      finishReason: message.stop_reason ?? undefined,
      usage: tokenUsage(message.usage?.input_tokens, message.usage?.output_tokens),
    };
  }

  protected verifyCall(apiKey: string): HttpCall {
    return {
      url: `${API}/models?limit=1`,
      init: { method: 'GET', headers: { 'x-api-key': apiKey, 'anthropic-version': API_VERSION } },
    };
  }
}
