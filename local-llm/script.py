from fastapi import FastAPI, HTTPException
from pydantic import BaseModel
from llama_cpp import Llama
import uvicorn
import time
import traceback
import sys

app = FastAPI()

MODEL_PATH = "mistral-7b-instruct-v0.2.Q4_K_M.gguf"

print("Loading model... this might take 30–60s the first time.")
start = time.time()

try:
    llm = Llama(
        model_path=MODEL_PATH, 
        n_ctx=4096,
        n_threads=4,  # Reduced from 8
        n_gpu_layers=0,
        verbose=True,  # Enable verbose logging
        n_batch=512  # Add batch size
    )
    print(f"Model loaded in {time.time() - start:.1f}s")
except Exception as e:
    print(f"Failed to load model: {e}")
    traceback.print_exc()
    sys.exit(1)

class LLMRequest(BaseModel):
    model: str = "mistral"
    prompt: str
    stream: bool = False
    options: dict = {}

@app.post("/api/generate")
async def generate(req: LLMRequest):
    temperature = req.options.get("temperature", 0.1)
    max_tokens = req.options.get("num_predict", 1024)
    
    print(f"\n Generating with prompt length: {len(req.prompt)} chars")
    print(f"   Temperature: {temperature}, Max tokens: {max_tokens}")

    try:
        # Validate prompt isn't too long
        if len(req.prompt) > 15000:
            raise HTTPException(400, "Prompt too long")
        
        print("   Starting generation...")
        output = llm(
            req.prompt,
            temperature=temperature,
            max_tokens=max_tokens,
            stop=None,
            echo=False,
            repeat_penalty=1.1
        )
        print("   Generation complete!")

        text = output["choices"][0]["text"].strip()
        tokens = output.get("usage", {}).get("completion_tokens", 0)
        
        print(f" Generated {len(text)} chars ({tokens} tokens)")
        if len(text) > 0:
            print(f"   First 100 chars: {text[:100]}...")
        
        return {
            "response": text,
            "eval_count": tokens
        }
        
    except Exception as e:
        error_msg = f"Generation error: {str(e)}"
        print(f" {error_msg}")
        traceback.print_exc()
        raise HTTPException(status_code=500, detail=error_msg)

@app.get("/health")
async def health():
    return {"status": "ok", "model_loaded": llm is not None}

if __name__ == "__main__":
    uvicorn.run(app, host="0.0.0.0", port=11434, log_level="info")