declare module "node-llama-cpp" {
  export enum LlamaLogLevel {
    error = 0,
  }

  export interface LlamaEmbedding {
    vector: Float32Array | number[];
  }

  export interface LlamaEmbeddingContext {
    getEmbeddingFor: (text: string) => Promise<LlamaEmbedding>;
  }

  export interface LlamaModel {
    createEmbeddingContext: () => Promise<LlamaEmbeddingContext>;
  }

  export interface Llama {
    loadModel: (params: { modelPath: string }) => Promise<LlamaModel>;
  }

  export function getLlama(params: { logLevel: LlamaLogLevel }): Promise<Llama>;
  export function resolveModelFile(modelPath: string, cacheDir?: string): Promise<string>;
}
