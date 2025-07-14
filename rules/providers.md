A "provider" is a module that handles external services/APIs. Calling S3, AI models, creating browsers, calling our own APIs on other servers -- **anything** like that. Usually they involve a call that can throw an error.
- All providers are in `src/providers/`

