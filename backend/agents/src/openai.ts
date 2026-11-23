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

const API = 'https://api.openai.com/v1';

const ChatCompletion = z.object({
  model: z.string().optional(),
  choices: z
    .array(
      z.object({
        message: z.object({ content: z.string().nullable() }),
        finish_reason: z.string().nullable().optional(),
      }),
    )
    .min(1),
  usage: z
    .object({
      prompt_tokens: z.number().int().nonnegative().optional(),
      completion_tokens: z.number().int().nonnegative().optional(),
    })
    .optional(),
});

export class OpenAIAdapter extends HttpProviderAdapter {
  readonly id = 'openai';
  protected readonly displayName = 'OpenAI';

  protected chatCall(apiKey: string, model: string, request: ProviderRequest): HttpCall {
    const messages = [
      ...(request.system === undefined ? [] : [{ role: 'system', content: request.system }]),
      ...request.messages,
    ];
    return {
      url: `${API}/chat/completions`,
      init: {
        method: 'POST',
        headers: { authorization: `Bearer ${apiKey}`, 'content-type': 'application/json' },
        body: JSON.stringify({ model, messages, max_completion_tokens: request.maxOutputTokens }),
      },
    };
  }

  protected readChat(body: unknown, model: string): ProviderResponse {
    const completion = parseBody(ChatCompletion, body);
    const choice = completion.choices[0];
    if (choice === undefined || choice.message.content === null) {
      throw new ProviderFailure('bad_response', 'the response contained no message text');
    }
    return {
      text: choice.message.content,
      model: completion.model ?? model,
      finishReason: choice.finish_reason ?? undefined,
      usage: tokenUsage(completion.usage?.prompt_tokens, completion.usage?.completion_tokens),
    };
  }

  protected verifyCall(apiKey: string): HttpCall {
    return { url: `${API}/models`, init: { method: 'GET', headers: { authorization: `Bearer ${apiKey}` } } };
  }
}
