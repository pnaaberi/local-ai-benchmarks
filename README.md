# Local AI Benchmarks — RDNA4-16

A static, read-only research notebook for actual local inference on a Radeon RX 9070 XT workstation. Finnish interface; no third-party assets, analytics, account system, model API or remote execution controls. The machine name is a public alias.

## Current evidence

3 October 2026, Ollama 0.20.0, Qwen2.5-Coder14B Q4_K_M: three hardware/storage transformation tasks, three repeats each. Six exact answers in nine runs; all three storage additions were wrong. Median warm-request latency1.40562s; median runtime decode45.555tok/s. Results are a narrow experiment, not general accuracy or production acceptance. Ministral3 14B warmup encountered unexpected CPU offload and was excluded before task measurement.

`results.json` preserves exact prompts, outputs, expectations and metrics. `telemetry.json` uses relative seconds. `hardware.json` separates observed/owner-identified/unknown details. `benchmark.py` is the exact runner used; only fixed non-private hardware text enters the model, and no output is executed. Its loopback API address is a generic local endpoint, not the private machine address. `SHA256SUMS` hashes every published asset except itself; hashes establish byte identity, not independent attestation.

## Read and reproduce

Serve this directory with a static HTTP server. Open the index, filter by task/outcome, search, sort latency, expand a response or download receipts. With JavaScript disabled, a compact summary and evidence downloads remain accessible. On data-load/validation error the numerical result UI is hidden rather than showing zero.

To reproduce, inspect the script first. Requires Python3, Linux amdgpu readable sysfs telemetry, an existing Ollama service and the two exact listed model tags already installed. Run `python3 benchmark.py NEW_OUTPUT_DIRECTORY`. It refuses existing output directories, low disk space, other resident models, unsafe sampled resources and unexpected CPU offload. Requests are sequential, token-bounded and time-limited. It unloads its test models; it does not install models, alter drivers or delete files. A sampling alarm stops subsequent requests, not hardware-level immediate shutdown. Do not run against someone else's occupied inference service.

Known limits: full upstream/quant provenance, exact backend library, HIP/Vulkan parity, long context, tools, RAG, sustained-load/security acceptance, physical-device accessibility and whole-system energy remain unverified. Small warm prompts can benefit from caching. Package version is not runner-library proof. Default seed repeats are not independent cases.

The public export has no private repository history, operating credentials, real hostname, serials, addresses or owner identity. Hosting platforms may independently retain access logs. The GitHub account serving a public Pages URL is visible; a machine alias does not imply owner anonymity.
