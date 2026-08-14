#!/usr/bin/env python3
"""Generate a development CA and a server certificate for DNS hijack testing."""

from __future__ import annotations

import argparse
import ipaddress
from datetime import UTC, datetime, timedelta
from pathlib import Path

from cryptography import x509
from cryptography.hazmat.primitives import hashes, serialization
from cryptography.hazmat.primitives.asymmetric import rsa
from cryptography.x509.oid import ExtendedKeyUsageOID, NameOID


def write_private_key(path: Path, key: rsa.RSAPrivateKey) -> None:
    path.write_bytes(
        key.private_bytes(
            encoding=serialization.Encoding.PEM,
            format=serialization.PrivateFormat.TraditionalOpenSSL,
            encryption_algorithm=serialization.NoEncryption(),
        )
    )


def write_certificate(path: Path, certificate: x509.Certificate) -> None:
    path.write_bytes(certificate.public_bytes(serialization.Encoding.PEM))


def write_der_certificate(path: Path, certificate: x509.Certificate) -> None:
    path.write_bytes(certificate.public_bytes(serialization.Encoding.DER))


def load_or_create_ca(output: Path) -> tuple[rsa.RSAPrivateKey, x509.Certificate]:
    key_path = output / "krkr2-dev-ca-key.pem"
    cert_path = output / "krkr2-dev-ca.pem"
    if key_path.exists() and cert_path.exists():
        key = serialization.load_pem_private_key(key_path.read_bytes(), password=None)
        cert = x509.load_pem_x509_certificate(cert_path.read_bytes())
        if not isinstance(key, rsa.RSAPrivateKey):
            raise TypeError("Existing CA key is not RSA")
        return key, cert

    now = datetime.now(UTC)
    key = rsa.generate_private_key(public_exponent=65537, key_size=3072)
    subject = x509.Name(
        [
            x509.NameAttribute(NameOID.ORGANIZATION_NAME, "KRKR2 Web Development"),
            x509.NameAttribute(NameOID.COMMON_NAME, "KRKR2 Web Development CA"),
        ]
    )
    certificate = (
        x509.CertificateBuilder()
        .subject_name(subject)
        .issuer_name(subject)
        .public_key(key.public_key())
        .serial_number(x509.random_serial_number())
        .not_valid_before(now - timedelta(days=1))
        .not_valid_after(now + timedelta(days=3650))
        .add_extension(x509.BasicConstraints(ca=True, path_length=0), critical=True)
        .add_extension(
            x509.KeyUsage(
                digital_signature=True,
                content_commitment=False,
                key_encipherment=False,
                data_encipherment=False,
                key_agreement=False,
                key_cert_sign=True,
                crl_sign=True,
                encipher_only=False,
                decipher_only=False,
            ),
            critical=True,
        )
        .add_extension(x509.SubjectKeyIdentifier.from_public_key(key.public_key()), critical=False)
        .sign(key, hashes.SHA256())
    )
    write_private_key(key_path, key)
    write_certificate(cert_path, certificate)
    write_der_certificate(output / "krkr2-dev-ca.crt", certificate)
    return key, certificate


def subject_alt_name(hostname: str) -> x509.GeneralName:
    try:
        return x509.IPAddress(ipaddress.ip_address(hostname))
    except ValueError:
        return x509.DNSName(hostname)


def generate_server_certificate(output: Path, hosts: list[str]) -> tuple[Path, Path, Path]:
    output.mkdir(parents=True, exist_ok=True)
    ca_key, ca_cert = load_or_create_ca(output)
    now = datetime.now(UTC)
    server_key = rsa.generate_private_key(public_exponent=65537, key_size=2048)
    unique_hosts = list(dict.fromkeys(hosts + ["localhost", "127.0.0.1"]))
    subject = x509.Name(
        [
            x509.NameAttribute(NameOID.ORGANIZATION_NAME, "KRKR2 Web Development"),
            x509.NameAttribute(NameOID.COMMON_NAME, hosts[0]),
        ]
    )
    certificate = (
        x509.CertificateBuilder()
        .subject_name(subject)
        .issuer_name(ca_cert.subject)
        .public_key(server_key.public_key())
        .serial_number(x509.random_serial_number())
        .not_valid_before(now - timedelta(days=1))
        .not_valid_after(now + timedelta(days=365))
        .add_extension(x509.BasicConstraints(ca=False, path_length=None), critical=True)
        .add_extension(
            x509.KeyUsage(
                digital_signature=True,
                content_commitment=False,
                key_encipherment=True,
                data_encipherment=False,
                key_agreement=False,
                key_cert_sign=False,
                crl_sign=False,
                encipher_only=False,
                decipher_only=False,
            ),
            critical=True,
        )
        .add_extension(x509.ExtendedKeyUsage([ExtendedKeyUsageOID.SERVER_AUTH]), critical=False)
        .add_extension(x509.SubjectAlternativeName([subject_alt_name(host) for host in unique_hosts]), critical=False)
        .add_extension(x509.AuthorityKeyIdentifier.from_issuer_public_key(ca_key.public_key()), critical=False)
        .sign(ca_key, hashes.SHA256())
    )

    key_path = output / "server-key.pem"
    cert_path = output / "server.pem"
    ca_path = output / "krkr2-dev-ca.pem"
    write_der_certificate(output / "krkr2-dev-ca.crt", ca_cert)
    write_private_key(key_path, server_key)
    write_certificate(cert_path, certificate)
    return key_path, cert_path, ca_path


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--host", action="append", required=True, help="DNS name or IP in the certificate SAN; repeatable")
    parser.add_argument("--output", type=Path, default=Path("certs"), help="certificate output directory")
    args = parser.parse_args()
    key_path, cert_path, ca_path = generate_server_certificate(args.output.resolve(), args.host)
    print(f"CA_CERT={ca_path}")
    print(f"ANDROID_CA_CERT={args.output.resolve() / 'krkr2-dev-ca.crt'}")
    print(f"SERVER_CERT={cert_path}")
    print(f"SERVER_KEY={key_path}")
    print("HOSTS=" + ",".join(args.host))


if __name__ == "__main__":
    main()
