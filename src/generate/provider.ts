export interface GenerateRequest {
  system: string;
  prompt: string;
  maxTokens: number;
}

export interface Provider {
  generate(req: GenerateRequest): Promise<string>;
}
