import React from 'react'
import { renderToString } from 'react-dom/server'
import cheerio from 'cheerio'
import Image, { getImageProps } from 'next/image'
import LegacyImage from 'next/legacy/image'
import {
  imageConfigDefault,
  prepareImageConfig,
  type ImageConfigComplete,
} from 'next/dist/shared/lib/image-config'
import { ImageConfigContext } from 'next/dist/shared/lib/image-config-context.shared-runtime'
import { getImgProps } from 'next/dist/shared/lib/get-img-props'
import defaultLoader from 'next/dist/shared/lib/image-loader'
import { findClosestQuality } from 'next/dist/shared/lib/find-closest-quality'
import { deepFreeze } from 'next/dist/shared/lib/deep-freeze'

function createConfig() {
  return {
    ...imageConfigDefault,
    domains: [...imageConfigDefault.domains],
    formats: [...imageConfigDefault.formats],
    remotePatterns: [...imageConfigDefault.remotePatterns],
    deviceSizes: [1080, 640],
    imageSizes: [256, 128],
    qualities: [90, 60],
  }
}

const configStates = [
  'mutable',
  'deviceSizes frozen',
  'qualities frozen',
  'deeply frozen',
] as const

describe.each(configStates)('image config preparation (%s)', (state) => {
  function createSource() {
    const config = createConfig()
    if (state === 'deviceSizes frozen') Object.freeze(config.deviceSizes)
    if (state === 'qualities frozen') Object.freeze(config.qualities)
    if (state === 'deeply frozen') deepFreeze(config)
    return config
  }

  it('owns sorted arrays without changing the source and caches by identity', () => {
    const source = createSource()
    const before = JSON.stringify(source)
    const prepared = prepareImageConfig(source)

    expect(prepared).not.toBe(source)
    expect(prepareImageConfig(source)).toBe(prepared)
    expect(prepared.deviceSizes).toEqual([640, 1080])
    expect(prepared.imageSizes).toEqual([256, 128])
    expect(prepared.allSizes).toEqual([128, 256, 640, 1080])
    expect(prepared.qualities).toEqual([60, 90])
    expect(prepared.deviceSizes).not.toBe(source.deviceSizes)
    expect(prepared.imageSizes).not.toBe(source.imageSizes)
    expect(prepared.qualities).not.toBe(source.qualities)
    expect(Object.isFrozen(prepared.deviceSizes)).toBe(false)
    expect(Object.isFrozen(prepared.qualities)).toBe(false)
    expect(JSON.stringify(source)).toBe(before)
    expect(findClosestQuality(undefined, prepared)).toBe(60)
  })

  it('generates sorted widths and lower quality on a tie', () => {
    const source = createSource()
    const before = JSON.stringify(source)
    const { props } = getImgProps(
      { src: '/test.png', alt: 'test', fill: true },
      { defaultLoader, imgConf: source }
    )

    expect(props.srcSet).toBe(
      '/_next/image?url=%2Ftest.png&w=640&q=60 640w, /_next/image?url=%2Ftest.png&w=1080&q=60 1080w'
    )
    expect(JSON.stringify(source)).toBe(before)
  })
})

it('does not share a prepared config between equal source objects', () => {
  const first = createConfig()
  const second = createConfig()
  const preparedFirst = prepareImageConfig(first)
  const preparedSecond = prepareImageConfig(second)

  expect(preparedFirst).not.toBe(preparedSecond)
  expect(preparedFirst.deviceSizes).not.toBe(preparedSecond.deviceSizes)
  expect(preparedFirst.allSizes).not.toBe(preparedSecond.allSizes)
})

it('preserves absent and undefined qualities without adding defaults', () => {
  const { qualities: _qualities, ...withoutQualities } = createConfig()
  const absent = prepareImageConfig(withoutQualities)
  expect(Object.hasOwn(absent, 'qualities')).toBe(false)
  expect(findClosestQuality(undefined, absent)).toBe(75)

  const withUndefined = prepareImageConfig({
    ...withoutQualities,
    qualities: undefined,
  })
  expect(Object.hasOwn(withUndefined, 'qualities')).toBe(true)
  expect(withUndefined.qualities).toBeUndefined()
  expect(findClosestQuality(undefined, withUndefined)).toBe(75)
})

it('keeps the precomputed allSizes fast path in getImgProps', () => {
  const config = {
    ...createConfig(),
    allSizes: [900, 500],
  }
  const { props } = getImgProps(
    { src: '/test.png', alt: 'test', fill: true, sizes: 'auto' },
    { defaultLoader, imgConf: config }
  )

  expect(props.srcSet).toBe(
    '/_next/image?url=%2Ftest.png&w=900&q=90 900w, /_next/image?url=%2Ftest.png&w=500&q=90 500w'
  )
})

it('keeps the public getImageProps fallback stable', () => {
  const before = JSON.stringify(imageConfigDefault)
  const first = getImageProps({ src: '/test.png', alt: 'test', fill: true })
  const second = getImageProps({ src: '/test.png', alt: 'test', fill: true })

  expect(first.props.srcSet).toBe(second.props.srcSet)
  expect(first.props.srcSet).toContain('w=640&q=75 640w')
  expect(JSON.stringify(imageConfigDefault)).toBe(before)
})

function renderCandidates(
  config: ImageConfigComplete,
  legacy: boolean,
  src = '/test.png'
) {
  const image = legacy
    ? React.createElement(LegacyImage, {
        src,
        alt: 'test',
        layout: 'fill',
        loading: 'eager',
      })
    : React.createElement(Image, {
        src,
        alt: 'test',
        fill: true,
        loading: 'eager',
      })
  const html = renderToString(
    React.createElement(ImageConfigContext.Provider, { value: config }, image)
  )
  const srcSet = cheerio.load(html)('img').first().attr('srcset')
  return srcSet?.split(', ').map((candidate) => {
    const [src, width] = candidate.split(' ')
    const url = new URL(src, 'http://localhost')
    return [
      url.pathname,
      url.searchParams.get('w'),
      url.searchParams.get('q'),
      width,
    ]
  })
}

it.each(['next/image', 'next/legacy/image'])(
  'renders %s repeatedly with distinct frozen context options',
  (name) => {
    const first = { ...createConfig(), path: '/image-a' }
    const second = {
      ...createConfig(),
      path: '/image-b',
      deviceSizes: [1200, 750],
      imageSizes: [300, 150],
      qualities: [95, 55],
    }
    deepFreeze(first)
    deepFreeze(second)
    const firstBefore = JSON.stringify(first)
    const secondBefore = JSON.stringify(second)
    const legacy = name === 'next/legacy/image'

    for (let i = 0; i < 2; i++) {
      expect(renderCandidates(first, legacy)).toEqual([
        ['/image-a', '640', '60', '640w'],
        ['/image-a', '1080', '60', '1080w'],
      ])
      expect(renderCandidates(second, legacy)).toEqual([
        ['/image-b', '750', '55', '750w'],
        ['/image-b', '1200', '55', '1200w'],
      ])
    }
    expect(JSON.stringify(first)).toBe(firstBefore)
    expect(JSON.stringify(second)).toBe(secondBefore)
  }
)

it.each(['next/image', 'next/legacy/image'])(
  'uses SSR context localPatterns with %s without modifying prepared options',
  (name) => {
    const config = {
      ...createConfig(),
      localPatterns: [{ pathname: '**', search: '' }],
    }
    deepFreeze(config)
    const before = JSON.stringify(config)

    expect(() =>
      renderCandidates(config, name === 'next/legacy/image', '/test.png?v=1')
    ).toThrow('using a query string which is not configured')
    expect(JSON.stringify(config)).toBe(before)
  }
)
