from fastapi import FastAPI, HTTPException, Request
from fastapi.exceptions import RequestValidationError
from fastapi.responses import JSONResponse


class ProviderError(Exception):
    """数据源（千帆 / Mock）统一异常。"""

    def __init__(self, message: str, code: str = "provider_error"):
        self.message = message
        self.code = code
        super().__init__(message)


def ok(data, message: str = "ok") -> dict:
    return {"code": 0, "data": data, "message": message}


def register_exception_handlers(app: FastAPI) -> None:
    @app.exception_handler(HTTPException)
    async def http_exception_handler(_: Request, exc: HTTPException):
        return JSONResponse(
            status_code=exc.status_code,
            content={"code": exc.status_code, "data": None, "message": str(exc.detail)},
        )

    @app.exception_handler(RequestValidationError)
    async def validation_handler(_: Request, exc: RequestValidationError):
        return JSONResponse(
            status_code=422,
            content={"code": 422, "data": None, "message": f"参数校验失败: {exc.errors()}"},
        )

    @app.exception_handler(ProviderError)
    async def provider_handler(_: Request, exc: ProviderError):
        return JSONResponse(
            status_code=502,
            content={"code": 502, "data": None, "message": exc.message},
        )
