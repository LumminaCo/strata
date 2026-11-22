use std::sync::Arc;

use rustls::{
    ClientConfig, DigitallySignedStruct, Error, RootCertStore, SignatureScheme,
    client::{
        danger::{HandshakeSignatureValid, ServerCertVerified, ServerCertVerifier},
        verify_server_cert_signed_by_trust_anchor,
    },
    crypto::{WebPkiSupportedAlgorithms, verify_tls12_signature, verify_tls13_signature},
    pki_types::{CertificateDer, ServerName, UnixTime},
    server::ParsedCertificate,
};
use strata_core::{CoreError, Result, TlsMode};
use tokio_postgres_rustls::MakeRustlsConnect;

pub(crate) fn connector(mode: TlsMode) -> Result<MakeRustlsConnect> {
    let provider = rustls::crypto::ring::default_provider();
    let algorithms = provider.signature_verification_algorithms;
    let builder = ClientConfig::builder_with_provider(Arc::new(provider))
        .with_safe_default_protocol_versions()
        .map_err(|_| tls_error("Cannot configure TLS protocol versions"))?;
    let mut roots = RootCertStore::empty();
    if matches!(mode, TlsMode::VerifyCa | TlsMode::VerifyFull) {
        roots.add_parsable_certificates(rustls_native_certs::load_native_certs().certs);
        if roots.is_empty() {
            return Err(tls_error(
                "No usable certificates found in the system trust store",
            ));
        }
    }
    let config = match mode {
        TlsMode::VerifyFull => builder.with_root_certificates(roots).with_no_client_auth(),
        _ => builder
            .dangerous()
            .with_custom_certificate_verifier(Arc::new(PostgresVerifier {
                roots: (mode == TlsMode::VerifyCa).then_some(roots),
                algorithms,
            }))
            .with_no_client_auth(),
    };
    Ok(MakeRustlsConnect::new(config))
}

fn tls_error(message: &str) -> CoreError {
    CoreError::Tls {
        message: message.into(),
    }
}

#[derive(Debug)]
struct PostgresVerifier {
    roots: Option<RootCertStore>,
    algorithms: WebPkiSupportedAlgorithms,
}

impl ServerCertVerifier for PostgresVerifier {
    fn verify_server_cert(
        &self,
        leaf: &CertificateDer<'_>,
        intermediates: &[CertificateDer<'_>],
        _: &ServerName<'_>,
        _: &[u8],
        now: UnixTime,
    ) -> std::result::Result<ServerCertVerified, Error> {
        // libpq prefer/require use encryption without peer verification.
        // verify-ca validates the trust chain and verify-full also checks the name.
        if let Some(roots) = &self.roots {
            verify_server_cert_signed_by_trust_anchor(
                &ParsedCertificate::try_from(leaf)?,
                roots,
                intermediates,
                now,
                self.algorithms.all,
            )?;
        }
        Ok(ServerCertVerified::assertion())
    }

    fn verify_tls12_signature(
        &self,
        message: &[u8],
        cert: &CertificateDer<'_>,
        signature: &DigitallySignedStruct,
    ) -> std::result::Result<HandshakeSignatureValid, Error> {
        verify_tls12_signature(message, cert, signature, &self.algorithms)
    }

    fn verify_tls13_signature(
        &self,
        message: &[u8],
        cert: &CertificateDer<'_>,
        signature: &DigitallySignedStruct,
    ) -> std::result::Result<HandshakeSignatureValid, Error> {
        verify_tls13_signature(message, cert, signature, &self.algorithms)
    }

    fn supported_verify_schemes(&self) -> Vec<SignatureScheme> {
        self.algorithms.supported_schemes()
    }
}
