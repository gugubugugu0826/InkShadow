package com.inkshadow.android.poc.cache

import com.inkshadow.android.poc.crypto.ProjectKeyAliases
import com.inkshadow.android.poc.wire.EncryptedSyncChunkDto
import com.inkshadow.android.poc.wire.SyncChunkAadDto
import com.inkshadow.android.poc.wire.SyncObjectType
import com.inkshadow.android.poc.wire.SyncWireValidator
import java.io.DataInputStream
import java.io.DataOutputStream
import java.io.EOFException
import java.io.IOException
import java.nio.channels.Channels
import java.nio.channels.FileChannel
import java.nio.charset.StandardCharsets
import java.nio.file.AtomicMoveNotSupportedException
import java.nio.file.Files
import java.nio.file.Path
import java.nio.file.StandardCopyOption
import java.nio.file.StandardOpenOption

class FileEncryptedCacheStore(
    cacheDirectory: Path,
) : EncryptedCacheStore {
    private val monitor = Any()
    private val root: Path = cacheDirectory.toAbsolutePath().normalize()

    init {
        try {
            Files.createDirectories(root)
            if (Files.isSymbolicLink(root) || !Files.isDirectory(root)) {
                throw CacheSecurityException(CacheSecurityErrorCode.STORAGE_FAILURE)
            }
        } catch (error: CacheSecurityException) {
            throw error
        } catch (_: IOException) {
            throw CacheSecurityException(CacheSecurityErrorCode.STORAGE_FAILURE)
        }
    }

    override fun putIfNonceUnused(record: EncryptedCacheRecord): Boolean =
        synchronized(monitor) {
            validateRecord(record)
            val target = recordPath(record.recordId)
            try {
                if (Files.exists(target)) {
                    throw CacheSecurityException(CacheSecurityErrorCode.RECORD_ALREADY_EXISTS)
                }
                val records = recordFiles()
                if (records.size >= MAX_RECORDS) {
                    throw CacheSecurityException(CacheSecurityErrorCode.CACHE_LIMIT_EXCEEDED)
                }
                val nonceAlreadyUsed =
                    records
                        .asSequence()
                        .map(::readRecord)
                        .any {
                            it.keyAlias == record.keyAlias &&
                                it.encrypted.nonce == record.encrypted.nonce
                        }
                if (nonceAlreadyUsed) {
                    return@synchronized false
                }
                writeAtomically(target, record)
                true
            } catch (error: CacheSecurityException) {
                throw error
            } catch (_: IOException) {
                throw CacheSecurityException(CacheSecurityErrorCode.STORAGE_FAILURE)
            }
        }

    override fun read(recordId: String): EncryptedCacheRecord =
        synchronized(monitor) {
            SyncWireValidator.requireUuidV7(recordId)
            val target = recordPath(recordId)
            try {
                if (!Files.exists(target)) {
                    throw CacheSecurityException(CacheSecurityErrorCode.RECORD_NOT_FOUND)
                }
                readRecord(target)
            } catch (error: CacheSecurityException) {
                throw error
            } catch (_: IOException) {
                throw CacheSecurityException(CacheSecurityErrorCode.STORAGE_FAILURE)
            }
        }

    private fun recordFiles(): List<Path> =
        Files.list(root).use { stream ->
            stream
                .filter { path -> path.fileName.toString().endsWith(RECORD_SUFFIX) }
                .sorted()
                .toList()
        }

    private fun recordPath(recordId: String): Path {
        SyncWireValidator.requireUuidV7(recordId)
        val resolved = root.resolve("$recordId$RECORD_SUFFIX").normalize()
        if (resolved.parent != root) {
            throw CacheSecurityException(CacheSecurityErrorCode.STORAGE_FAILURE)
        }
        return resolved
    }

    private fun writeAtomically(
        target: Path,
        record: EncryptedCacheRecord,
    ) {
        val temporary = Files.createTempFile(root, ".inkshadow-cache-", ".tmp")
        try {
            FileChannel
                .open(
                    temporary,
                    StandardOpenOption.WRITE,
                    StandardOpenOption.TRUNCATE_EXISTING,
                ).use { channel ->
                    val output = DataOutputStream(Channels.newOutputStream(channel))
                    CacheRecordCodec.write(output, record)
                    output.flush()
                    channel.force(true)
                }
            try {
                Files.move(temporary, target, StandardCopyOption.ATOMIC_MOVE)
            } catch (_: AtomicMoveNotSupportedException) {
                Files.move(temporary, target)
            }
        } finally {
            Files.deleteIfExists(temporary)
        }
    }

    private fun readRecord(path: Path): EncryptedCacheRecord {
        if (Files.isSymbolicLink(path) ||
            !Files.isRegularFile(path) ||
            Files.size(path) > MAX_RECORD_BYTES
        ) {
            throw CacheSecurityException(CacheSecurityErrorCode.INVALID_RECORD)
        }
        val record =
            try {
                DataInputStream(Files.newInputStream(path)).use(CacheRecordCodec::read)
            } catch (error: CacheSecurityException) {
                throw error
            } catch (_: EOFException) {
                throw CacheSecurityException(CacheSecurityErrorCode.INVALID_RECORD)
            }
        validateRecord(record)
        if (path.fileName.toString() != "${record.recordId}$RECORD_SUFFIX") {
            throw CacheSecurityException(CacheSecurityErrorCode.INVALID_RECORD)
        }
        return record
    }

    private fun validateRecord(record: EncryptedCacheRecord) {
        if (record.schemaVersion != ENCRYPTED_CACHE_SCHEMA_VERSION ||
            !KEY_ALIAS.matches(record.keyAlias)
        ) {
            throw CacheSecurityException(CacheSecurityErrorCode.INVALID_RECORD)
        }
        SyncWireValidator.requireUuidV7(record.recordId)
        SyncWireValidator.validate(record.encrypted)
        if (record.keyAlias !=
            ProjectKeyAliases.forProject(
                record.encrypted.aad.projectId,
                record.encrypted.aad.keyVersion,
            )
        ) {
            throw CacheSecurityException(CacheSecurityErrorCode.INVALID_RECORD)
        }
    }

    private companion object {
        const val RECORD_SUFFIX = ".iscache"
        const val MAX_RECORDS = 10_000
        const val MAX_RECORD_BYTES = 8_100_000L
        const val MAX_KEY_ALIAS_BYTES = 256
        val KEY_ALIAS =
            Regex(
                "^inkshadow\\.project\\." +
                    "[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-" +
                    "[0-9a-f]{12}\\.v[1-9][0-9]{0,15}$",
                RegexOption.IGNORE_CASE,
            )
    }
}

private object CacheRecordCodec {
    private val magic = "INKSC01".toByteArray(StandardCharsets.US_ASCII)

    fun write(
        output: DataOutputStream,
        record: EncryptedCacheRecord,
    ) {
        output.write(magic)
        output.writeInt(record.schemaVersion)
        output.writeString(record.recordId)
        output.writeString(record.keyAlias)
        with(record.encrypted) {
            output.writeInt(schemaVersion)
            output.writeString(algorithm)
            output.writeString(nonce)
            output.writeString(ciphertext)
            output.writeString(ciphertextSha256)
            output.writeInt(plaintextBytes)
            with(aad) {
                output.writeString(projectId)
                output.writeString(objectType.wireValue)
                output.writeString(objectId)
                output.writeString(versionId)
                output.writeLong(chunkIndex)
                output.writeLong(keyVersion)
            }
        }
    }

    fun read(input: DataInputStream): EncryptedCacheRecord {
        val actualMagic = ByteArray(magic.size)
        input.readFully(actualMagic)
        if (!actualMagic.contentEquals(magic)) {
            throw CacheSecurityException(CacheSecurityErrorCode.INVALID_RECORD)
        }
        val record =
            EncryptedCacheRecord(
                schemaVersion = input.readInt(),
                recordId = input.readString(MAX_SMALL_STRING_BYTES),
                keyAlias = input.readString(MAX_KEY_ALIAS_BYTES),
                encrypted =
                    EncryptedSyncChunkDto(
                        schemaVersion = input.readInt(),
                        algorithm = input.readString(MAX_SMALL_STRING_BYTES),
                        nonce = input.readString(MAX_SMALL_STRING_BYTES),
                        ciphertext = input.readString(MAX_CIPHERTEXT_BYTES),
                        ciphertextSha256 = input.readString(MAX_SMALL_STRING_BYTES),
                        plaintextBytes = input.readInt(),
                        aad =
                            SyncChunkAadDto(
                                projectId = input.readString(MAX_SMALL_STRING_BYTES),
                                objectType =
                                    SyncObjectType.fromWire(
                                        input.readString(MAX_SMALL_STRING_BYTES),
                                    ),
                                objectId = input.readString(MAX_SMALL_STRING_BYTES),
                                versionId = input.readString(MAX_SMALL_STRING_BYTES),
                                chunkIndex = input.readLong(),
                                keyVersion = input.readLong(),
                            ),
                    ),
            )
        if (input.read() != -1) {
            throw CacheSecurityException(CacheSecurityErrorCode.INVALID_RECORD)
        }
        return record
    }

    private fun DataOutputStream.writeString(value: String) {
        val bytes = value.toByteArray(StandardCharsets.UTF_8)
        writeInt(bytes.size)
        write(bytes)
    }

    private fun DataInputStream.readString(maxBytes: Int): String {
        val size = readInt()
        if (size !in 0..maxBytes) {
            throw CacheSecurityException(CacheSecurityErrorCode.INVALID_RECORD)
        }
        val bytes = ByteArray(size)
        readFully(bytes)
        return bytes.toString(StandardCharsets.UTF_8)
    }

    private const val MAX_SMALL_STRING_BYTES = 512
    private const val MAX_KEY_ALIAS_BYTES = 256
    private const val MAX_CIPHERTEXT_BYTES = 8_000_000
}
