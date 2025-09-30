const express = require("express");
const cors = require("cors");
require("dotenv").config();

const { MongoClient, ServerApiVersion, ObjectId } = require("mongodb");
const stripe = require("stripe")(process.env.PAYMENT_GATEWAY_KEY);

const app = express();

// ✅ Middleware
app.use(cors());
app.use(express.json());

// ✅ MongoDB Connection
const uri = `mongodb+srv://${process.env.DB_USER}:${process.env.DB_PASS}@coffeestore.vf4l8z4.mongodb.net/?retryWrites=true&w=majority&appName=coffeeStore`;
const client = new MongoClient(uri, {
    serverApi: {
        version: ServerApiVersion.v1,
        strict: true,
        deprecationErrors: true,
    },
});

async function run() {
    try {
        await client.connect();

        const db = client.db("parcelDB");
        const usersCollection = db.collection("users");
        const parcelsCollection = db.collection("parcels");
        const paymentsCollection = db.collection("payments");

        // ✅ Upsert User
        app.post("/users", async (req, res) => {
            const email = req.body.email;
            const userExist = await usersCollection.findOne({ email });
            if (userExist) {
                return res.status(200).send({
                    message: "user  already exist",
                    insertedId: false,
                });
            }
            const user = req.body;
            const result = await usersCollection.insertOne(user);
            res.send(result);
        });

        // ✅ Get all parcels OR filter by user email
        app.get("/parcels", async (req, res) => {
            try {
                const userEmail = req.query.email;
                const query = userEmail ? { created_by: userEmail } : {};
                const options = { sort: { createdAt: -1 } };

                const parcels = await parcelsCollection
                    .find(query, options)
                    .toArray();

                res.status(200).send(parcels);
            } catch (error) {
                console.error("Error fetching parcels:", error);
                res.status(500).send({ message: "Failed to get parcels" });
            }
        });

        // ✅ Add new parcel
        app.post("/parcels", async (req, res) => {
            try {
                const parcel = req.body;
                parcel.createdAt = new Date(); // add createdAt
                const result = await parcelsCollection.insertOne(parcel);
                res.status(201).send(result);
            } catch (error) {
                res.status(500).send({ message: "Failed to create parcel" });
            }
        });

        // ✅ Get parcel by ID
        app.get("/parcels/:id", async (req, res) => {
            try {
                const id = req.params.id;
                const parcel = await parcelsCollection.findOne({
                    _id: new ObjectId(id),
                });
                res.send(parcel);
            } catch (error) {
                res.status(500).send({ error: error.message });
            }
        });

        // ✅ Delete parcel by ID
        app.delete("/parcels/:id", async (req, res) => {
            try {
                const id = req.params.id;
                const result = await parcelsCollection.deleteOne({
                    _id: new ObjectId(id),
                });
                res.send(result);
            } catch (error) {
                res.status(500).send({ message: "Failed to delete parcel" });
            }
        });

        // ✅ Get all payments (or by user email)
        app.get("/payments", async (req, res) => {
            try {
                const userEmail = req.query.email;
                const query = userEmail ? { email: userEmail } : {};
                const options = { sort: { createdAt: -1 } };

                const payments = await paymentsCollection
                    .find(query, options)
                    .toArray();

                res.send(payments);
            } catch (err) {
                res.status(500).send({ error: err.message });
            }
        });

        // ✅ Save payment + update parcel
        app.post("/payments", async (req, res) => {
            try {
                const {
                    parcelId,
                    transactionId,
                    amount,
                    email,
                    paymentMethod,
                } = req.body;

                // Validation
                if (!parcelId || !ObjectId.isValid(parcelId)) {
                    return res.status(400).send({ error: "Invalid parcelId" });
                }
                if (!transactionId || typeof transactionId !== "string") {
                    return res
                        .status(400)
                        .send({ error: "Invalid transactionId" });
                }
                if (!amount || isNaN(amount)) {
                    return res.status(400).send({ error: "Invalid amount" });
                }
                if (!email || typeof email !== "string") {
                    return res.status(400).send({ error: "Invalid email" });
                }

                // Update parcel status
                const filter = { _id: new ObjectId(parcelId) };
                const updateParcel = {
                    $set: {
                        payment_status: "paid",
                        paymentDate: new Date(),
                        transactionId,
                    },
                };
                const updateResult = await parcelsCollection.updateOne(
                    filter,
                    updateParcel
                );

                if (updateResult.matchedCount === 0) {
                    return res.status(404).send({ error: "Parcel not found" });
                }

                // Insert payment record
                const paymentDoc = {
                    parcelId,
                    email,
                    transactionId,
                    amount,
                    paymentMethod,
                    status: "succeeded",
                    paid_at_string: new Date().toISOString(),
                    createdAt: new Date(),
                };

                const paymentResult = await paymentsCollection.insertOne(
                    paymentDoc
                );

                res.send({
                    message: "Payment recorded successfully",
                    insertedId: paymentResult.insertedId,
                });
            } catch (err) {
                res.status(500).send({
                    error: "Internal Server Error",
                    details: err.message,
                });
            }
        });

        // ✅ Create Stripe Payment Intent
        app.post("/create-payment-intent", async (req, res) => {
            try {
                const amountInCents = req.body.amountInCents;
                const paymentIntent = await stripe.paymentIntents.create({
                    amount: amountInCents,
                    currency: "usd",
                    payment_method_types: ["card"],
                });

                res.send({
                    clientSecret: paymentIntent.client_secret,
                });
            } catch (err) {
                res.status(500).send({ error: err.message });
            }
        });

        // ✅ Ping MongoDB
        await client.db("admin").command({ ping: 1 });
        console.log("✅ Successfully connected to MongoDB!");
    } finally {
        // await client.close(); // keep connection open for API usage
    }
}
run().catch(console.dir);

// ✅ Test Route
app.get("/", (req, res) => {
    res.send("🚀 Parcel Server is Running");
});

// ✅ Server listen
const port = process.env.PORT || 5000;
app.listen(port, () => {
    console.log(`🚀 Server is running on port ${port}`);
});
