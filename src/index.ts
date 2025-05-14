import express, { Request, Response, Router } from 'express';
import cors from 'cors';
import dotenv from 'dotenv';
import Stripe from 'stripe';
import { createClient } from '@supabase/supabase-js';

// Load environment variables
dotenv.config();

// Define constants
const PORT = process.env.PORT || 5000;
const STRIPE_SECRET_KEY = process.env.STRIPE_SECRET_KEY || '';
const FRONTEND_URL = process.env.FRONTEND_URL || 'http://localhost:5173';
const SUPABASE_URL = process.env.SUPABASE_URL || '';
const SUPABASE_ANON_KEY = process.env.SUPABASE_ANON_KEY || '';

// Initialize Stripe
const stripe = new Stripe(STRIPE_SECRET_KEY);

// Initialize Supabase client
const supabase = createClient(SUPABASE_URL, SUPABASE_ANON_KEY);

// Initialize express app
const app = express();

// Middleware
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Configure CORS to allow requests from all origins
app.use(cors({
  origin: '*',
  methods: ['GET', 'POST', 'PUT', 'DELETE', 'PATCH', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization']
}));

// Create a router for our API endpoints
const router = Router();

// Helper function to create enrollment and payment in a transaction
async function createEnrollmentWithPayment(
  userId: string,
  courseId: string,
  amount: number,
  sessionId: string
): Promise<any> {
  console.log(`Creating enrollment for user ${userId} in course ${courseId}`);
  
  // Check if user is already enrolled
  const { data: existingEnrollment, error: checkError } = await supabase
    .from('enrollments')
    .select('id')
    .eq('student_id', userId)
    .eq('course_id', courseId)
    .maybeSingle();
  
  if (checkError) {
    console.error('Error checking existing enrollment:', checkError);
    throw checkError;
  }
  
  // If already enrolled, only create payment record if it doesn't exist
  if (existingEnrollment) {
    console.log(`User ${userId} already enrolled in course ${courseId}`);
    
    // Check if payment record already exists for this enrollment and transaction
    const { data: existingPayment, error: paymentCheckError } = await supabase
      .from('payments')
      .select('id')
      .eq('enrollment_id', existingEnrollment.id)
      .eq('transaction_id', sessionId)
      .maybeSingle();
    
    if (paymentCheckError) {
      console.error('Error checking existing payment:', paymentCheckError);
      throw paymentCheckError;
    }
    
    // If payment doesn't exist, create it
    if (!existingPayment && amount > 0) {
      const { error: paymentError } = await supabase
        .from('payments')
        .insert([{
          enrollment_id: existingEnrollment.id,
          amount: amount,
          payment_method: 'stripe',
          transaction_id: sessionId,
          status: 'completed'
        }]);
      
      if (paymentError) {
        console.error('Error creating payment record:', paymentError);
        throw paymentError;
      }
    }
    
    return existingEnrollment;
  }
  
  // Create new enrollment
  const { data: enrollmentData, error: enrollmentError } = await supabase
    .from('enrollments')
    .insert([{
      student_id: userId,
      course_id: courseId,
      status: 'active'
    }])
    .select()
    .single();
  
  if (enrollmentError) {
    console.error('Error creating enrollment:', enrollmentError);
    throw enrollmentError;
  }
  
  // Create payment record if it's a paid course
  if (amount > 0) {
    const { error: paymentError } = await supabase
      .from('payments')
      .insert([{
        enrollment_id: enrollmentData.id,
        amount: amount,
        payment_method: 'stripe',
        transaction_id: sessionId,
        status: 'completed'
      }]);
    
    if (paymentError) {
      console.error('Error creating payment record:', paymentError);
      // Don't throw here as enrollment is already created
    }
  }
  
  return enrollmentData;
}

// Root route - used for ping
router.get('/', (req: Request, res: Response): void => {
  res.send('Server is online and ready to serve requests');
});

// Create Stripe checkout session
router.post('/api/create-checkout-session', async (req: Request, res: Response): Promise<void> => {
  try {
    const { courseId, courseTitle, coursePrice, userId, successUrl, cancelUrl } = req.body;

    console.log("SERVER HAS PING")

    if (!courseId || !courseTitle || coursePrice === undefined || !userId) {
      res.status(400).json({ error: 'Missing required parameters' });
      return;
    }

    // Create metadata for the session
    const metadata: Record<string, string> = {
      courseId,
      userId
    };

    // Create a checkout session
    const session = await stripe.checkout.sessions.create({
      payment_method_types: ['card'],
      line_items: [
        {
          price_data: {
            currency: 'usd',
            product_data: {
              name: courseTitle,
              description: `Enrollment for course: ${courseTitle}`,
            },
            unit_amount: Math.round(coursePrice * 100), // convert to cents
          },
          quantity: 1,
        },
      ],
      mode: 'payment',
      success_url: successUrl || `${FRONTEND_URL}/payment/success?session_id={CHECKOUT_SESSION_ID}`,
      cancel_url: cancelUrl || `${FRONTEND_URL}/courses/${courseId}`,
      metadata,
    });

    res.json({ id: session.id, url: session.url });
  } catch (error) {
    console.log("EROIOr");
    console.error('Error creating checkout session:', error);
    res.status(500).json({ error: 'Failed to create checkout session' });
  }
});

// Webhook endpoint to handle Stripe events
router.post('/api/stripe-webhook', express.raw({ type: 'application/json' }), async (req: Request, res: Response): Promise<void> => {
  const payload = req.body;
  const sig = req.headers['stripe-signature'];

  if (!sig) {
    res.status(400).send('Missing stripe-signature header');
    return;
  }

  let event;

  try {
    // Verify webhook signature and extract the event
    const endpointSecret = process.env.STRIPE_WEBHOOK_SECRET || '';
    event = stripe.webhooks.constructEvent(payload, sig, endpointSecret);
  } catch (error: any) {
    console.error(`Webhook Error: ${error.message}`);
    res.status(400).send(`Webhook Error: ${error.message}`);
    return;
  }

  // Handle the checkout.session.completed event
  if (event.type === 'checkout.session.completed') {
    const session = event.data.object as Stripe.Checkout.Session;

    // Ensure payment is successful
    if (session.payment_status === 'paid') {
      // Type-check for metadata and ensure both properties exist
      if (session.metadata && 'courseId' in session.metadata && 'userId' in session.metadata) {
        const courseId = session.metadata.courseId;
        const userId = session.metadata.userId;
        
        try {
          // Process the enrollment using Supabase
          await createEnrollmentWithPayment(
            userId,
            courseId,
            (session.amount_total || 0) / 100, // Convert from cents to dollars
            session.id
          );
          console.log(`Webhook: Successfully enrolled user ${userId} in course ${courseId}`);
        } catch (error) {
          console.error('Error processing enrollment:', error);
        }
      } else {
        console.error('Missing metadata in session', session.id);
      }
    }
  }

  res.status(200).send({ received: true });
});

// Verify payment and enroll student
router.get('/api/verify-payment/:sessionId', async (req: Request, res: Response): Promise<void> => {
  try {
    const { sessionId } = req.params;
    
    // Retrieve the complete session data from Stripe
    const session = await stripe.checkout.sessions.retrieve(sessionId, {
      expand: ['payment_intent'] // Expand the payment_intent to get full details
    });
    
    if (session.payment_status === 'paid') {
      // Type-check for metadata and ensure properties exist with fallbacks
      const courseId = session.metadata?.courseId || '';
      const userId = session.metadata?.userId || '';
      
      // Get the amount from the payment_intent or line_items
      let amount = 0;
      if (session.amount_total) {
        // Convert from cents to dollars
        amount = session.amount_total / 100;
      }
      
      try {
        // Create enrollment and payment in Supabase
        const enrollmentData = await createEnrollmentWithPayment(
          userId,
          courseId,
          amount,
          sessionId
        );
        
        // Return success response with enrollment data
        res.json({
          success: true,
          courseId,
          userId,
          amount,
          paymentId: session.payment_intent,
          transactionId: sessionId,
          enrollmentId: enrollmentData.id,
          enrollment: enrollmentData
        });
      } catch (error) {
        console.error('Error creating enrollment:', error);
        res.status(500).json({ 
          success: false, 
          error: 'Failed to create enrollment record',
          message: 'Your payment was successful, but we could not complete your enrollment. Please contact support.'
        });
      }
    } else {
      res.json({
        success: false,
        message: 'Payment not completed',
        paymentStatus: session.payment_status
      });
    }
  } catch (error) {
    console.error('Error verifying payment:', error);
    res.status(500).json({ error: 'Failed to verify payment' });
  }
});

// Create enrollment for free courses
router.post('/api/create-free-enrollment', async (req: Request, res: Response): Promise<void> => {
  try {
    const { userId, courseId } = req.body;

    if (!userId || !courseId) {
      res.status(400).json({ error: 'Missing required parameters' });
      return;
    }

    // Verify this is a free course
    const { data: courseData, error: courseError } = await supabase
      .from('courses')
      .select('price')
      .eq('id', courseId)
      .single();

    if (courseError) {
      console.error('Error fetching course:', courseError);
      res.status(500).json({ success: false, error: 'Failed to verify course' });
      return;
    }

    // Ensure the course is free
    if (courseData.price > 0) {
      res.status(400).json({ 
        success: false, 
        error: 'This is not a free course',
        message: 'Paid courses require checkout through Stripe'
      });
      return;
    }

    // Create enrollment (reusing the same function used for paid enrollments)
    const enrollmentData = await createEnrollmentWithPayment(
      userId,
      courseId,
      0, // Zero amount for free courses
      'free-enrollment' // No transaction ID for free courses
    );

    res.json({
      success: true,
      enrollment: enrollmentData
    });
  } catch (error) {
    console.error('Error creating free enrollment:', error);
    res.status(500).json({ success: false, error: 'Failed to create enrollment' });
  }
});

// Use the router middleware
app.use(router);

// Start the server
app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
}); 

export default app;
