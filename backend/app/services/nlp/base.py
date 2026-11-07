from dataclasses import dataclass, field
from typing import Protocol


@dataclass
class AnalysisResult:
    sentiment: str
    score: float
    keywords: list[str] = field(default_factory=list)
    analyzer_type: str = "local"


class Analyzer(Protocol):
    async def analyze(self, text: str) -> AnalysisResult: ...

    async def analyze_batch(self, texts: list[str]) -> list[AnalysisResult]: ...
