"""HTTP transport regressions; no OCR model or network access required."""
import contextlib
import io
import json
import unittest
from unittest.mock import Mock, patch

from test_ocr_layout import load_service_without_models


class HTTPTransportTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.service = load_service_without_models()

    def handler(self, path="/api/extract", error=None, phase="body"):
        handler = object.__new__(self.service.TERAHandler)
        body = json.dumps({"fileName": "test.pdf", "images": []}).encode()
        handler.path = path
        handler.headers = {"Content-Length": str(len(body))}
        handler.rfile = io.BytesIO(body)
        handler.wfile = Mock()
        handler.close_connection = False
        handler.send_response = Mock()
        handler.send_header = Mock()
        handler.end_headers = Mock()
        handler.log_message = Mock()
        if error is not None:
            target = handler.end_headers if phase == "headers" else handler.wfile.write
            target.side_effect = error
        return handler

    def test_disconnected_success_response_is_not_retried_as_500(self):
        for error in (ConnectionAbortedError(10053, "aborted"),
                      ConnectionResetError(10054, "reset"),
                      BrokenPipeError("closed"), TimeoutError("write timed out")):
            for phase in ("headers", "body"):
                with self.subTest(error=type(error).__name__, phase=phase):
                    handler = self.handler(error=error, phase=phase)
                    stderr = io.StringIO()
                    with patch.object(self.service, "process_document", return_value={"success": True}) as process:
                        with contextlib.redirect_stderr(stderr):
                            handler.do_POST()
                    process.assert_called_once()
                    handler.send_response.assert_called_once_with(200)
                    self.assertEqual(stderr.getvalue(), "")
                    self.assertTrue(handler.close_connection)
                    handler.log_message.assert_called_once()

    def test_genuine_processing_errors_still_return_500(self):
        for error in (ValueError("OCR failed"), ConnectionAbortedError("engine failed")):
            with self.subTest(error=type(error).__name__):
                handler = self.handler()
                stderr = io.StringIO()
                with patch.object(self.service, "process_document", side_effect=error):
                    with contextlib.redirect_stderr(stderr):
                        handler.do_POST()
                handler.send_response.assert_called_once_with(500)
                payload = json.loads(handler.wfile.write.call_args.args[0])
                self.assertFalse(payload["success"])
                self.assertEqual(payload["error"], str(error))
                self.assertIn("Traceback", stderr.getvalue())
                self.assertFalse(handler.close_connection)

    def test_disconnected_error_response_is_not_retried(self):
        handler = self.handler(error=BrokenPipeError("closed"))
        stderr = io.StringIO()
        with patch.object(self.service, "process_document", side_effect=ValueError("OCR failed")):
            with contextlib.redirect_stderr(stderr):
                handler.do_POST()
        handler.send_response.assert_called_once_with(500)
        handler.wfile.write.assert_called_once()
        self.assertEqual(stderr.getvalue().count("Traceback"), 1)
        self.assertTrue(handler.close_connection)

    def test_unserializable_result_returns_500_before_sending_success_headers(self):
        handler = self.handler()
        with patch.object(self.service, "process_document", return_value={"data": object()}):
            with contextlib.redirect_stderr(io.StringIO()):
                handler.do_POST()
        handler.send_response.assert_called_once_with(500)
        self.assertFalse(json.loads(handler.wfile.write.call_args.args[0])["success"])

    def test_disconnect_during_read_does_not_start_ocr(self):
        for partial in (False, True):
            with self.subTest(partial_body=partial):
                handler = self.handler()
                handler.rfile = Mock()
                if partial:
                    handler.rfile.read.return_value = b'{"'
                else:
                    handler.rfile.read.side_effect = ConnectionAbortedError(10053, "aborted")
                with patch.object(self.service, "process_document") as process:
                    handler.do_POST()
                process.assert_not_called()
                handler.send_response.assert_not_called()
                self.assertTrue(handler.close_connection)

    def test_preflight_health_and_not_found_handle_closed_connections(self):
        for method, path in (("do_OPTIONS", "/api/extract"), ("do_GET", "/health"),
                             ("do_GET", "/unknown"), ("do_POST", "/unknown")):
            with self.subTest(method=method, path=path):
                handler = self.handler(path, ConnectionAbortedError(10053, "aborted"), "headers")
                with contextlib.redirect_stderr(io.StringIO()) as stderr:
                    getattr(handler, method)()
                self.assertEqual(stderr.getvalue(), "")
                self.assertEqual(handler.send_response.call_count, 1)
                self.assertTrue(handler.close_connection)

    def test_next_request_succeeds_after_a_client_disconnect(self):
        with patch.object(self.service, "process_document", return_value={"success": True, "data": {}}):
            self.handler(error=ConnectionAbortedError(10053, "aborted")).do_POST()
            health = self.handler("/health")
            health.do_GET()
            self.assertEqual(json.loads(health.wfile.write.call_args.args[0])["status"], "ok")
            next_request = self.handler()
            next_request.do_POST()
            next_request.send_response.assert_called_once_with(200)
            self.assertTrue(json.loads(next_request.wfile.write.call_args.args[0])["success"])


if __name__ == "__main__":
    unittest.main()
