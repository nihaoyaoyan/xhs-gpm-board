"""大模型情感分析（OpenAI 兼容协议），失败自动降级到本地 NLP。"""

from __future__ import annotations

import json
import re

import httpx

from app.core.config import settings
from app.core.logging import logger
from app.services.nlp.base import AnalysisResult, Analyzer
from app.services.nlp.local import LocalAnalyzer

SYSTEM_PROMPT = (
    "你是电商评论分析助手。对每条评论输出 JSON 数组，每项包含："
    'sentiment（"positive"|"neutral"|"negative"）、score（0-1 浮点）、keywords（最多5个中文关键词数组）。'
    "只输出 JSON，不要任何解释。"
)


class LLMAnalyzer(Analyzer):
    def __init__(self, fallback: Analyzer | None = None) -> None:
        self.fallback = fallback or LocalAnalyzer()

    @property
    def enabled(self) -> bool:
        return bool(settings.llm_api_key)

    def _url(self) -> str:
        return settings.llm_base_url.rstrip("/") + "/chat/completions"

    @staticmethod
    def _parse(text: str, expected: int) -> list[dict]:
        match = re.search(r"\[[\s\S]*\]", text)
        if not match:
            raise ValueError("模型未返回 JSON 数组")
        data = json.loads(match.group(0))
        if not isinstance(data, list) or len(data) != expected:
            raise ValueError("模型返回条数与输入不一致")
        return data

    async def analyze(self, text: str) -> AnalysisResult:
        return (await self.analyze_batch([text])).pop()

    async def analyze_batch(self, texts: list[str]) -> list[AnalysisResult]:
        if not texts:
            return []
        if not self.enabled:
            return await self.fallback.analyze_batch(texts)

        payload = {
            "model": settings.llm_model,
            "temperature": 0.2,
            "messages": [
                {"role": "system", "content": SYSTEM_PROMPT},
                {"role": "user", "content": json.dumps(texts, ensure_ascii=False)},
            ],
        }
        headers = {"Authorization": f"Bearer {settings.llm_api_key}"}
        try:
            async with httpx.AsyncClient(timeout=15.0) as client:
                response = await client.post(self._url(), json=payload, headers=headers)
                response.raise_for_status()
            content = response.json()["choices"][0]["message"]["content"]
            parsed = self._parse(content, len(texts))
        except Exception as exc:
            logger.warning("LLM 情感分析失败，降级本地 NLP: %s", exc)
            return await self.fallback.analyze_batch(texts)

        results: list[AnalysisResult] = []
        for item in parsed:
            sentiment = str(item.get("sentiment", "neutral"))
            if sentiment not in {"positive", "neutral", "negative"}:
                sentiment = "neutral"
            try:
                score = float(item.get("score", 0.5))
            except (TypeError, ValueError):
                score = 0.5
            keywords = [str(word) for word in (item.get("keywords") or [])][:5]
            results.append(
                AnalysisResult(
                    sentiment=sentiment,
                    score=round(score, 4),
                    keywords=keywords,
                    analyzer_type="llm",
                )
            )
        return results
