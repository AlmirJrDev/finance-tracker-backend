const express = require('express')
const router = express.Router()
const authController = require('../controllers/authController')
const { authenticate } = require('../middleware/auth')

router.post('/google', authController.googleLogin)
router.get('/me', authenticate, authController.me)
router.put('/preferences', authenticate, authController.updatePreferences)

module.exports = router