import { describe, expect, it } from 'vitest'
import { fpsMotionTestHtml } from './fps-motion-fixture.js'

describe('FPS motion diagnostic fixture', () => {
  it('is a self-contained 1080p animation with syntactically valid JavaScript', () => {
    expect(fpsMotionTestHtml).toContain('<canvas id="motion" width="1920" height="1080"></canvas>')
    expect(fpsMotionTestHtml).toContain('requestAnimationFrame(draw)')
    expect(fpsMotionTestHtml).not.toContain('file://')
    expect(fpsMotionTestHtml).not.toContain('obsCSS')
    const script = /<script>([\s\S]*?)<\/script>/.exec(fpsMotionTestHtml)?.[1]
    expect(script).toBeTruthy()
    expect(() => new Function(script ?? '')).not.toThrow()
  })
})
