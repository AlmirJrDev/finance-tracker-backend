const express = require('express')
const router = express.Router()
const ctrl = require('../controllers/recurringController')
const { authenticate } = require('../middleware/auth')

router.use(authenticate)

router.get('/', ctrl.list)
router.post('/', ctrl.create)
router.get('/:id', ctrl.getById)
router.put('/:id', ctrl.update)
router.delete('/:id', ctrl.remove)
router.post('/:id/apply', ctrl.applyToMonth)

module.exports = router