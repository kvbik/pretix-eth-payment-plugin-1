import logging
import subprocess
import os
import grpc

from threecities.v1.transfer_verification_pb2_grpc import TransferVerificationServiceStub

logger = logging.getLogger(__name__)


def get_grpc_ca_root_cert_file_path():
    try:
        completed_process = subprocess.run(
            ["mkcert", "-CAROOT"], capture_output=True, check=True, text=True)
        ca_root_path = completed_process.stdout.strip()
        return os.path.join(ca_root_path, "rootCA.pem")
    except subprocess.CalledProcessError as e:
        logger.error(f"error obtaining CA root path: {e}")
        return os.getenv("THREECITIES_GRPC_CA_ROOT_CERT") or None


grpc_stub = None


def ensure_grpc_initialized():
    global grpc_stub
    if grpc_stub is not None:
        return

    ca_cert_path = get_grpc_ca_root_cert_file_path()
    if not ca_cert_path:
        logger.error("grpc init failed: CA root cert file path not found")
        return

    try:
        with open(ca_cert_path, 'rb') as f:
            root_cert = f.read()
        channel_credentials = grpc.ssl_channel_credentials(root_cert)
        channel = grpc.secure_channel("127.0.0.1:8443", channel_credentials)
        grpc_stub = TransferVerificationServiceStub(channel)
    except Exception as e:
        logger.error(f"failed to initialize grpc channel or stub: {e}")


# verify_payment synchronously calls the remote 3cities grpc service to
# attempt to verify the passed
# threecities.v1.transfer_verification_pb2.TransferVerificationRequest.
# Returns True if and only if the payment was successfully verified.
def verify_payment(req):
    is_verified = False
    ensure_grpc_initialized()
    if not grpc_stub:
        logger.error("grpc stub unavailable, payment verification cannot proceed")
    else:
        try:
            resp = grpc_stub.TransferVerification(req)
            logger.info(f"{resp.description} {resp.error}")
            if resp.is_verified:
                is_verified = True
        except grpc.RpcError as e:
            logger.error(f"grpc call failed: {e}")

    return is_verified
