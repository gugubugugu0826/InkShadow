package com.inkshadow.android.keystore

import android.os.Build
import android.security.keystore.KeyGenParameterSpec
import android.security.keystore.KeyProperties
import com.inkshadow.android.poc.crypto.AeadCiphertext
import com.inkshadow.android.poc.crypto.AeadKeyHandle
import com.inkshadow.android.poc.crypto.ProjectKeyAliases
import java.security.GeneralSecurityException
import java.security.KeyStore
import javax.crypto.Cipher
import javax.crypto.KeyGenerator
import javax.crypto.SecretKey
import javax.crypto.spec.GCMParameterSpec

enum class AndroidKeystoreErrorCode {
    KEYSTORE_UNAVAILABLE,
    KEY_GENERATION_FAILED,
    KEY_NOT_FOUND,
    KEY_EXPORTABLE,
    INVALID_NONCE,
    ENCRYPTION_FAILED,
    INTEGRITY_FAILURE,
}

class AndroidKeystoreException(
    val code: AndroidKeystoreErrorCode,
) : IllegalStateException(code.name)

/**
 * Production Android key handle.
 *
 * Key bytes never cross this boundary. AndroidKeyStore generates the AES-256
 * project key, the provider generates every encryption IV, and construction
 * fails when the returned key exposes encoded material.
 */
class AndroidKeystoreAesGcmKeyHandle private constructor(
    override val alias: String,
) : AeadKeyHandle {
    init {
        ensureKeyExists()
        assertNonExportable()
    }

    override fun assertNonExportable() {
        val key = loadKey()
        if (key.encoded != null || key.format != null) {
            throw AndroidKeystoreException(AndroidKeystoreErrorCode.KEY_EXPORTABLE)
        }
    }

    override fun encrypt(
        plaintext: ByteArray,
        aad: ByteArray,
    ): AeadCiphertext =
        try {
            val cipher = Cipher.getInstance(TRANSFORMATION)
            cipher.init(Cipher.ENCRYPT_MODE, loadKey())
            cipher.updateAAD(aad)
            val ciphertext = cipher.doFinal(plaintext)
            val nonce = cipher.iv?.copyOf()
                ?: throw AndroidKeystoreException(AndroidKeystoreErrorCode.INVALID_NONCE)
            if (nonce.size != GCM_NONCE_BYTES) {
                throw AndroidKeystoreException(AndroidKeystoreErrorCode.INVALID_NONCE)
            }
            AeadCiphertext(nonce = nonce, ciphertextAndTag = ciphertext)
        } catch (error: AndroidKeystoreException) {
            throw error
        } catch (_: Exception) {
            throw AndroidKeystoreException(AndroidKeystoreErrorCode.ENCRYPTION_FAILED)
        }

    override fun decrypt(
        nonce: ByteArray,
        ciphertextAndTag: ByteArray,
        aad: ByteArray,
    ): ByteArray {
        if (nonce.size != GCM_NONCE_BYTES) {
            throw AndroidKeystoreException(AndroidKeystoreErrorCode.INVALID_NONCE)
        }
        return try {
            val cipher = Cipher.getInstance(TRANSFORMATION)
            cipher.init(
                Cipher.DECRYPT_MODE,
                loadKey(),
                GCMParameterSpec(GCM_TAG_BITS, nonce),
            )
            cipher.updateAAD(aad)
            cipher.doFinal(ciphertextAndTag)
        } catch (_: Exception) {
            throw AndroidKeystoreException(AndroidKeystoreErrorCode.INTEGRITY_FAILURE)
        }
    }

    private fun ensureKeyExists() {
        synchronized(keyCreationLock) {
            val keyStore = loadKeyStore()
            try {
                if (keyStore.containsAlias(alias)) {
                    return
                }
                val builder =
                    KeyGenParameterSpec
                        .Builder(
                            alias,
                            KeyProperties.PURPOSE_ENCRYPT or KeyProperties.PURPOSE_DECRYPT,
                        ).setKeySize(AES_KEY_BITS)
                        .setBlockModes(KeyProperties.BLOCK_MODE_GCM)
                        .setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE)
                        .setRandomizedEncryptionRequired(true)
                        .setUserAuthenticationRequired(false)
                if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.P) {
                    builder.setUnlockedDeviceRequired(true)
                }
                val generator =
                    KeyGenerator.getInstance(
                        KeyProperties.KEY_ALGORITHM_AES,
                        ANDROID_KEYSTORE,
                    )
                generator.init(builder.build())
                generator.generateKey()
            } catch (_: Exception) {
                throw AndroidKeystoreException(AndroidKeystoreErrorCode.KEY_GENERATION_FAILED)
            }
        }
    }

    private fun loadKey(): SecretKey {
        val key =
            try {
                loadKeyStore().getKey(alias, null) as? SecretKey
            } catch (_: GeneralSecurityException) {
                throw AndroidKeystoreException(AndroidKeystoreErrorCode.KEYSTORE_UNAVAILABLE)
            }
        return key
            ?: throw AndroidKeystoreException(AndroidKeystoreErrorCode.KEY_NOT_FOUND)
    }

    private fun loadKeyStore(): KeyStore =
        try {
            KeyStore.getInstance(ANDROID_KEYSTORE).apply { load(null) }
        } catch (_: Exception) {
            throw AndroidKeystoreException(AndroidKeystoreErrorCode.KEYSTORE_UNAVAILABLE)
        }

    companion object {
        private const val ANDROID_KEYSTORE = "AndroidKeyStore"
        private const val TRANSFORMATION = "AES/GCM/NoPadding"
        private const val AES_KEY_BITS = 256
        private const val GCM_NONCE_BYTES = 12
        private const val GCM_TAG_BITS = 128
        private val keyCreationLock = Any()

        fun forProject(
            projectId: String,
            keyVersion: Long,
        ): AndroidKeystoreAesGcmKeyHandle =
            AndroidKeystoreAesGcmKeyHandle(
                alias = ProjectKeyAliases.forProject(projectId, keyVersion),
            )
    }
}
