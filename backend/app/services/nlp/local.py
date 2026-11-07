"""本地 NLP：jieba 关键词提取 + SnowNLP 情感打分。"""

from __future__ import annotations

import logging

import jieba
import jieba.posseg as pseg
from snownlp import SnowNLP

from app.services.nlp.base import AnalysisResult, Analyzer

jieba.setLogLevel(logging.WARNING)

STOPWORDS = {
    "这个", "那个", "什么", "就是", "还是", "有点", "比较", "感觉", "真的", "非常", "已经",
    "但是", "因为", "所以", "而且", "然后", "现在", "时候", "东西", "一下", "我们", "你们",
    "他们", "一个", "没有", "可以", "不是", "很", "都", "也", "还", "又", "太", "更", "和",
    "与", "在", "有", "是", "的", "了", "着", "过", "吃", "买", "收到", "整体", "分量",
}

POSITIVE_WORDS = {"好", "鲜", "新鲜", "划算", "喜欢", "满意", "稳定", "省心", "漂亮", "干净", "扎实"}


def extract_keywords(text: str, top_k: int = 5) -> list[str]:
    counts: dict[str, int] = {}
    for word, flag in pseg.cut(text):
        word = word.strip()
        if len(word) < 2 or word in STOPWORDS:
            continue
        if not (flag.startswith("n") or flag.startswith("v") or flag.startswith("a")):
            continue
        counts[word] = counts.get(word, 0) + 1
    ranked = sorted(counts.items(), key=lambda item: (-item[1], -len(item[0])))
    return [word for word, _ in ranked[:top_k]]


def local_sentiment(text: str) -> tuple[str, float]:
    if not text.strip():
        return "neutral", 0.5
    score = float(SnowNLP(text).sentiments)
    if score >= 0.66:
        return "positive", score
    if score <= 0.33:
        return "negative", score
    return "neutral", score


class LocalAnalyzer(Analyzer):
    async def analyze(self, text: str) -> AnalysisResult:
        try:
            sentiment, score = local_sentiment(text)
            keywords = extract_keywords(text)
        except Exception:
            sentiment, score, keywords = "neutral", 0.5, []
        return AnalysisResult(
            sentiment=sentiment,
            score=round(score, 4),
            keywords=keywords,
            analyzer_type="local",
        )

    async def analyze_batch(self, texts: list[str]) -> list[AnalysisResult]:
        return [await self.analyze(text) for text in texts]
