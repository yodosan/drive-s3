/*
 * @adonisjs/drive-s3
 *
 * (c) Harminder Virk <virk@adonisjs.com>
 *
 * For the full copyright and license information, please view the LICENSE
 * file that was distributed with this source code.
 */

import { format } from 'url'
import getStream from 'get-stream'
import { LoggerContract } from '@ioc:Adonis/Core/Logger'
import { getSignedUrl } from '@aws-sdk/s3-request-presigner'

import {
  CannotCopyFileException,
  CannotMoveFileException,
  CannotReadFileException,
  CannotWriteFileException,
  CannotDeleteFileException,
  CannotGetMetaDataException,
  CannotSetVisibilityException,
} from '@adonisjs/core/build/standalone'

import {
  Visibility,
  WriteOptions,
  ContentHeaders,
  S3DriverConfig,
  S3DriverContract,
  DriveFileStats,
} from '@ioc:Adonis/Core/Drive'

import {
  S3Client,
  PutObjectCommand,
  GetObjectCommand,
  CopyObjectCommand,
  HeadObjectCommand,
  DeleteObjectCommand,
  PutObjectAclCommand,
  GetObjectAclCommand,
  GetObjectCommandInput,
} from '@aws-sdk/client-s3'

/**
 * An implementation of the s3 driver for AdonisJS drive
 */
export class S3Driver implements S3DriverContract {
  /**
   * Reference to the s3 client
   */
  public adapter: S3Client

  /**
   * Name of the driver
   */
  public name: 's3' = 's3'

  /**
   * The URI for the grant applicable to public
   */
  private publicGrantUri = 'http://acs.amazonaws.com/groups/global/AllUsers'

  constructor(private config: S3DriverConfig, private logger: LoggerContract) {
    /**
     * Use the top level key and secret to define AWS credentials
     */
    if (this.config.key && this.config.secret) {
      this.config.credentials = {
        accessKeyId: this.config.key,
        secretAccessKey: this.config.secret,
      }
    }

    this.adapter = new S3Client(this.config)
  }

  /**
   * Transforms the write options to S3 properties
   */
  private transformWriteOptions(options?: WriteOptions) {
    const {
      visibility,
      contentType,
      contentDisposition,
      contentEncoding,
      contentLanguage,
      cacheControl,
      ...adapterOptions
    } = Object.assign({ visibility: this.config.visibility }, options)

    if (contentType) {
      adapterOptions['ContentType'] = contentType
    }

    if (contentDisposition) {
      adapterOptions['ContentDisposition'] = contentDisposition
    }

    if (contentEncoding) {
      adapterOptions['ContentEncoding'] = contentEncoding
    }

    if (contentLanguage) {
      adapterOptions['ContentLanguage'] = contentLanguage
    }

    if (cacheControl) {
      adapterOptions['CacheControl'] = cacheControl
    }

    if (visibility === 'public') {
      adapterOptions.ACL = 'public-read'
    } else if (visibility === 'private') {
      adapterOptions.ACL = 'private'
    }

    this.logger.trace(adapterOptions, '@drive/s3 write options')
    return adapterOptions
  }

  /**
   * Transform content headers to S3 response content type
   */
  private transformContentHeaders(options?: ContentHeaders) {
    const contentHeaders: Omit<GetObjectCommandInput, 'Key' | 'Bucket'> = {}
    const { contentType, contentDisposition, contentEncoding, contentLanguage, cacheControl } =
      options || {}

    if (contentType) {
      contentHeaders['ResponseContentType'] = contentType
    }

    if (contentDisposition) {
      contentHeaders['ResponseContentDisposition'] = contentDisposition
    }

    if (contentEncoding) {
      contentHeaders['ResponseContentEncoding'] = contentEncoding
    }

    if (contentLanguage) {
      contentHeaders['ResponseContentLanguage'] = contentLanguage
    }

    if (cacheControl) {
      contentHeaders['ResponseCacheControl'] = cacheControl
    }

    this.logger.trace(contentHeaders, '@drive/s3 content headers')
    return contentHeaders
  }

  /**
   * Returns the file contents as a buffer. The buffer return
   * value allows you to self choose the encoding when
   * converting the buffer to a string.
   */
  public async get(location: string): Promise<Buffer> {
    return getStream.buffer(await this.getStream(location))
  }

  /**
   * Returns the file contents as a stream
   */
  public async getStream(location: string): Promise<NodeJS.ReadableStream> {
    try {
      const response = await this.adapter.send(
        new GetObjectCommand({ Key: location, Bucket: this.config.bucket })
      )

      return response.Body
    } catch (error) {
      throw CannotReadFileException.invoke(location, error)
    }
  }

  /**
   * A boolean to find if the location path exists or not
   */
  public async exists(location: string): Promise<boolean> {
    try {
      await this.adapter.send(
        new HeadObjectCommand({
          Key: location,
          Bucket: this.config.bucket,
        })
      )

      return true
    } catch (error) {
      if (error.$metadata?.httpStatusCode === 404) {
        return false
      }

      throw CannotGetMetaDataException.invoke(location, 'exists', error)
    }
  }

  /**
   * Not supported
   */
  public async getVisibility(location: string): Promise<Visibility> {
    try {
      const acl = await this.adapter.send(
        new GetObjectAclCommand({
          Key: location,
          Bucket: this.config.bucket,
        })
      )

      const publicGrant = (acl.Grants || []).find((grant) => {
        return grant.Grantee?.URI === this.publicGrantUri && grant.Permission === 'READ'
      })

      return publicGrant ? ('public' as const) : ('private' as const)
    } catch (error) {
      throw CannotGetMetaDataException.invoke(location, 'visibility', error)
    }
  }

  /**
   * Returns the file stats
   */
  public async getStats(location: string): Promise<DriveFileStats> {
    try {
      const stats = await this.adapter.send(
        new HeadObjectCommand({
          Key: location,
          Bucket: this.config.bucket,
        })
      )

      return {
        modified: stats.LastModified!,
        size: stats.ContentLength!,
        isFile: true,
        etag: stats.ETag,
      }
    } catch (error) {
      throw CannotGetMetaDataException.invoke(location, 'stats', error)
    }
  }

  /**
   * Not supported
   */
  public async getSignedUrl(
    location: string,
    options?: ContentHeaders & { expiresIn?: string | number }
  ): Promise<string> {
    try {
      return await getSignedUrl(
        this.adapter,
        new GetObjectCommand({
          Key: location,
          Bucket: this.config.bucket,
          ...this.transformContentHeaders(options),
        })
      )
    } catch (error) {
      throw CannotGetMetaDataException.invoke(location, 'signedUrl', error)
    }
  }

  /**
   * Returns URL to a given path
   */
  public async getUrl(location: string): Promise<string> {
    /**
     * Use the CDN URL if defined
     */
    if (this.config.cdnUrl) {
      return `${this.config.cdnUrl}/${location}`
    }

    const href = format(await this.adapter.config.endpoint())
    if (href.startsWith('https://s3.amazonaws')) {
      return `https://${this.config.bucket}.s3.amazonaws.com/${location}`
    }

    return `${href}/${this.config.bucket}/${location}`
  }

  /**
   * Write string|buffer contents to a destination. The missing
   * intermediate directories will be created (if required).
   */
  public async put(
    location: string,
    contents: Buffer | string,
    options?: WriteOptions
  ): Promise<void> {
    try {
      await this.adapter.send(
        new PutObjectCommand({
          Key: location,
          Body: contents,
          Bucket: this.config.bucket,
          ...this.transformWriteOptions(options),
        })
      )
    } catch (error) {
      throw CannotWriteFileException.invoke(location, error)
    }
  }

  /**
   * Write a stream to a destination. The missing intermediate
   * directories will be created (if required).
   */
  public async putStream(
    location: string,
    contents: NodeJS.ReadableStream,
    options?: WriteOptions
  ): Promise<void> {
    try {
      await this.adapter.send(
        new PutObjectCommand({
          Key: location,
          Body: contents,
          Bucket: this.config.bucket,
          ...this.transformWriteOptions(options),
        })
      )
    } catch (error) {
      throw CannotWriteFileException.invoke(location, error)
    }
  }

  /**
   * Not supported
   */
  public async setVisibility(location: string, visibility: Visibility): Promise<void> {
    try {
      await this.adapter.send(
        new PutObjectAclCommand({
          Key: location,
          Bucket: this.config.bucket,
          ...this.transformWriteOptions({ visibility }),
        })
      )
    } catch (error) {
      throw CannotSetVisibilityException.invoke(location, error)
    }
  }

  /**
   * Remove a given location path
   */
  public async delete(location: string): Promise<void> {
    try {
      await this.adapter.send(
        new DeleteObjectCommand({
          Key: location,
          Bucket: this.config.bucket,
        })
      )
    } catch (error) {
      throw CannotDeleteFileException.invoke(location, error)
    }
  }

  /**
   * Copy a given location path from the source to the desination.
   * The missing intermediate directories will be created (if required)
   */
  public async copy(source: string, destination: string, options?: WriteOptions): Promise<void> {
    options = options || {}

    try {
      /**
       * Copy visibility from the source. S3 doesn't retain the original
       * ACL. https://docs.aws.amazon.com/AmazonS3/latest/API/API_CopyObject.html
       */
      if (!options.visibility) {
        options.visibility = await this.getVisibility(source)
      }

      await this.adapter.send(
        new CopyObjectCommand({
          Key: destination,
          CopySource: `/${this.config.bucket}/${source}`,
          Bucket: this.config.bucket,
          ...this.transformWriteOptions(options),
        })
      )
    } catch (error) {
      throw CannotCopyFileException.invoke(source, destination, error.original || error)
    }
  }

  /**
   * Move a given location path from the source to the desination.
   * The missing intermediate directories will be created (if required)
   */
  public async move(source: string, destination: string, options?: WriteOptions): Promise<void> {
    try {
      await this.copy(source, destination, options)
      await this.delete(source)
    } catch (error) {
      throw CannotMoveFileException.invoke(source, destination, error.original || error)
    }
  }
}
