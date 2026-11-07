from functools import lru_cache

from app.core.config import settings
from app.services.nlp.base import Analyzer
from app.services.nlp.llm import LLMAnalyzer
from app.services.nlp.local import LocalAnalyzer


@lru_cache
def get_analyzer() -> Analyzer:
    """auto：配置了 LLM Key 用大模型，否则本地；llm/local 强制指定。"""
    if settings.analyzer_mode == "local":
        return LocalAnalyzer()
    if settings.analyzer_mode == "llm":
        return LLMAnalyzer()
    if settings.llm_api_key:
        return LLMAnalyzer()
    return LocalAnalyzer()
