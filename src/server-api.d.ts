/** Runtime modules are supplied by the pinned desktop host; these are the used faces. */
declare module '@deepseek-ai/dsh-typert-protocol' {
  export class TypertRemoteService { constructor(ctx: unknown, name: string); readonly ctx: unknown }
  export function Remote(method: unknown, context: ClassMethodDecoratorContext): void;
}
declare module '@deepseek-ai/dsh-llm' {
  export function createUserMessage(input: { content: unknown[]; source: { kind: string } }): unknown;
  export class BlockAssembler {
    push(chunk: unknown): void;
    readonly finish: { kind: string; failure?: { message: string } };
    blocks(): { type: string; text?: string }[];
  }
}
