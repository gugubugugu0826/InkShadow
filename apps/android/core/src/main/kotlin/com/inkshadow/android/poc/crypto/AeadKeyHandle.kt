package com.inkshadow.android.poc.crypto

data class AeadCiphertext(
    val nonce: ByteArray,
    val ciphertextAndTag: ByteArray,
)

/**
 * The interface exposes cryptographic operations, never raw key bytes.
 *
 * Production Android implementations must keep their key material in
 * AndroidKeyStore and make [assertNonExportable] fail closed if that invariant
 * cannot be demonstrated.
 */
interface AeadKeyHandle {
    val alias: String

    fun assertNonExportable()

    fun encrypt(
        plaintext: ByteArray,
        aad: ByteArray,
    ): AeadCiphertext

    fun decrypt(
        nonce: ByteArray,
        ciphertextAndTag: ByteArray,
        aad: ByteArray,
    ): ByteArray
}
